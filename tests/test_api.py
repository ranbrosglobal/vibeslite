"""API tests: every endpoint, plus security and error-handling behaviour."""
from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np
import pytest

from config import project_paths


# --------------------------------------------------------------------------- #
# service endpoints
# --------------------------------------------------------------------------- #
def test_health_endpoint(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "Vibes Lite"
    assert "NDVI" in body["capabilities"]["indices"]
    assert body["capabilities"]["opencv"] is True
    assert body["capabilities"]["segmentation_methods"]


def test_project_endpoint_reports_storage_without_absolute_paths(client, scene):
    body = client.get("/api/project").json()
    assert body["name"] == "Vibes Lite"
    assert body["crop_health_thresholds"]["very_low"] == 0.20
    assert body["paths"]["raw_data"] == "data/raw"
    assert "/Users/" not in json.dumps(body)
    assert body["storage"]["raw_files"] >= 1


def test_config_endpoint_exposes_thresholds_and_operations(client):
    body = client.get("/api/config").json()
    assert body["crop_health"]["thresholds"]["healthy"] == 0.80
    assert len(body["crop_health"]["classes"]) == 5
    assert "otsu" in body["opencv"]["operations"]
    assert body["opencv"]["presets"]
    assert body["segmentation"]["default"] == "threshold"


def test_dashboard_aggregates_results(client, ndvi_result):
    body = client.get("/api/dashboard").json()
    assert body["totals"]["analyses"] >= 1
    assert body["totals"]["rasters_available"] >= 1
    assert body["index"]["mean_ndvi"] is not None
    assert body["index"]["series"]
    assert body["activity"]


# --------------------------------------------------------------------------- #
# datasets and AOI
# --------------------------------------------------------------------------- #
def test_dataset_listing_and_detail(client, scene):
    listing = client.get("/api/datasets").json()
    names = [entry["name"] for entry in listing["datasets"]]
    assert scene["raster"] in names and scene["aoi"] in names
    raster_entry = next(entry for entry in listing["datasets"] if entry["name"] == scene["raster"])
    assert raster_entry["type"] == "raster"
    assert raster_entry["band_count"] == 4
    assert raster_entry["synthetic"] is True

    detail = client.get(f"/api/datasets/{scene['raster']}").json()
    assert detail["type"] == "raster"
    assert detail["metadata"]["band_descriptions"] == ["B02", "B03", "B04", "B08"]
    assert detail["band_resolution"]["bands"]["nir"] == 4
    assert detail["footprint"]["geometry_geojson"]["type"] == "Polygon"


def test_dataset_preview_returns_png(client, scene):
    response = client.get(f"/api/datasets/{scene['raster']}/preview", params={"max_size": 200})
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_dataset_footprint_geojson(client, scene):
    body = client.get(f"/api/datasets/{scene['raster']}/footprint").json()
    assert body["type"] == "Feature"
    assert body["properties"]["epsg"] == 32633
    assert len(body["properties"]["bounds_lonlat"]) == 4


def test_aoi_list_and_detail(client, scene):
    listing = client.get("/api/aoi").json()
    assert scene["aoi"] in [entry["name"] for entry in listing["aois"]]
    detail = client.get(f"/api/aoi/{scene['aoi']}").json()
    assert detail["feature_count"] == 4
    assert detail["area_ha"] > 0
    assert detail["geojson"]["type"] == "FeatureCollection"


def test_aoi_endpoint_accepts_inline_geojson_and_stores_it(client):
    payload = {
        "geojson": {
            "type": "Polygon",
            "coordinates": [[[12.0, 41.0], [12.02, 41.0], [12.02, 41.02], [12.0, 41.02], [12.0, 41.0]]],
        },
        "save_as": "api_test_aoi",
    }
    body = client.post("/api/aoi", json=payload).json()
    assert body["stored"] is True
    assert body["name"].endswith(".geojson")
    assert Path(project_paths()["raw_data"], body["name"]).exists()
    assert body["area_ha"] > 0


def test_aoi_endpoint_rejects_requests_without_aoi(client):
    response = client.post("/api/aoi", json={})
    assert response.status_code == 400
    assert "geojson" in response.json()["detail"].lower()


def test_aoi_endpoint_rejects_non_polygon_geojson(client):
    response = client.post("/api/aoi", json={"geojson": {"type": "Point", "coordinates": [12.0, 41.0]}})
    assert response.status_code == 400


def test_unknown_dataset_returns_404(client):
    assert client.get("/api/datasets/does-not-exist.tif").status_code == 404
    assert client.post("/api/ndvi", json={"dataset": "nope.tif"}).status_code == 404


# --------------------------------------------------------------------------- #
# uploads
# --------------------------------------------------------------------------- #
def test_upload_geojson_file(client):
    payload = json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"name": "uploaded"},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[12.0, 41.0], [12.01, 41.0], [12.01, 41.01], [12.0, 41.01], [12.0, 41.0]]],
                    },
                }
            ],
        }
    ).encode()
    response = client.post("/api/upload", files={"files": ("uploaded_field.geojson", payload, "application/geo+json")})
    assert response.status_code == 201
    body = response.json()
    assert body["uploaded"] == 1
    assert body["files"][0]["name"] == "uploaded_field.geojson"
    assert body["files"][0]["aoi"]["feature_count"] == 1


def test_upload_rejects_unsupported_extension(client):
    response = client.post("/api/upload", files={"files": ("malware.exe", b"MZ...", "application/octet-stream")})
    assert response.status_code == 400
    assert "Unsupported file type" in response.json()["detail"]


def test_upload_sanitises_path_traversal_names(client):
    payload = b"date,ndvi_mean\n2026-04-08,0.4\n"
    response = client.post("/api/upload", files={"files": ("../../etc/passwd.csv", payload, "text/csv")})
    assert response.status_code == 201
    stored_name = response.json()["files"][0]["name"]
    assert "/" not in stored_name and ".." not in stored_name
    assert Path(project_paths()["raw_data"], stored_name).exists()


def test_upload_rejects_oversized_files(client):
    oversized = b"a" * (9 * 1024 * 1024)  # limit is 8 MB in the test environment
    response = client.post("/api/upload", files={"files": ("big.csv", oversized, "text/csv")})
    assert response.status_code == 400
    assert "limit" in response.json()["detail"].lower()


def test_upload_rejects_unreadable_raster_and_keeps_disk_clean(client):
    before = {path.name for path in project_paths()["raw_data"].iterdir()}
    response = client.post("/api/upload", files={"files": ("broken.tif", b"not really a tiff", "image/tiff")})
    assert response.status_code == 400
    after = {path.name for path in project_paths()["raw_data"].iterdir()}
    assert "broken.tif" not in after
    assert before == after


# --------------------------------------------------------------------------- #
# NDVI
# --------------------------------------------------------------------------- #
def test_ndvi_endpoint_full_payload(ndvi_result):
    body = ndvi_result
    assert body["index"] == "NDVI"
    assert body["cached"] is False
    assert body["dataset"].endswith(".tif")
    assert body["aoi"].endswith(".geojson")
    assert body["band_resolution"]["method"] == "band_descriptions"
    assert body["band_resolution"]["bands"] == {"red": 3, "nir": 4}
    stats = body["statistics"]
    assert stats["min"] <= stats["mean"] <= stats["max"]
    assert stats["median"] is not None and stats["std"] is not None
    assert stats["valid_pixels"] > 0
    assert -1.0 <= stats["min"] and stats["max"] <= 1.0
    assert stats["histogram"]["bins"]
    assert len(body["health"]["classes"]) == 5
    assert sum(entry["percentage"] for entry in body["health"]["classes"]) == pytest.approx(100.0, abs=0.05)
    assert body["health"]["by_key"]["very_low"]["range"][1] == 0.20
    assert body["weak_vegetation"]["patch_count"] >= 1
    assert body["weak_vegetation"]["threshold"] == 0.45
    assert "anomalies" in body and body["anomalies"]["method"] == "zscore"
    assert body["field"]["vigour_score"] is not None
    assert body["interpretation"]["verdict"]
    assert body["clip"]["georeferenced"] is True
    assert body["clip"]["bounds_lonlat"][0] < body["clip"]["bounds_lonlat"][2]
    assert body["zones"]["total_zones"] >= 1
    assert body["zones"]["feature_collection"]["type"] == "FeatureCollection"
    assert any("synthetic" in warning.lower() for warning in body["warnings"])
    assert "not a diagnosis" in body["disclaimer"]


def test_ndvi_result_assets_are_downloadable(ndvi_result, client):
    keys = {asset["name"] for asset in ndvi_result["assets"]}
    for expected in ("index_map", "index_overlay", "health_map", "weak_vegetation"):
        assert expected in keys
    overlay = next(asset for asset in ndvi_result["assets"] if asset["name"] == "index_overlay")
    assert len(overlay["bounds_lonlat"]) == 4
    asset_url = overlay["url"]
    response = client.get(asset_url)
    assert response.status_code == 200
    assert response.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_ndvi_analysis_is_cached_on_repeat(client, scene, ndvi_result):
    response = client.post(
        "/api/ndvi",
        json={"dataset": scene["raster"], "aoi": scene["aoi"], "weak_threshold": 0.45},
    )
    body = response.json()
    assert body["cached"] is True
    assert body["result_id"] == ndvi_result["result_id"]


def test_ndvi_cache_is_skipped_when_disabled(client, scene, ndvi_result):
    response = client.post(
        "/api/ndvi",
        json={
            "dataset": scene["raster"],
            "aoi": scene["aoi"],
            "weak_threshold": 0.45,
            "use_cache": False,
            "include_visuals": False,
        },
    )
    body = response.json()
    assert body["cached"] is False
    assert body["result_id"] != ndvi_result["result_id"]
    assert body["assets"] == []


def test_ndvi_with_explicit_band_map(client, scene):
    response = client.post(
        "/api/ndvi",
        json={"dataset": scene["raster"], "aoi": scene["aoi"], "band_map": {"red": 3, "nir": 4}, "include_visuals": False},
    )
    body = response.json()
    assert body["band_resolution"]["method"] == "explicit"
    assert body["band_resolution"]["bands"] == {"red": 3, "nir": 4}
    assert body["statistics"]["mean"] is not None


def test_ndvi_accepts_savi_and_ndre_requests(client, scene):
    savi = client.post(
        "/api/ndvi",
        json={"dataset": scene["raster"], "aoi": scene["aoi"], "index": "SAVI", "include_visuals": False},
    )
    assert savi.status_code == 200
    assert savi.json()["index"] == "SAVI"
    ndre = client.post(
        "/api/ndvi",
        json={"dataset": scene["raster"], "aoi": scene["aoi"], "index": "NDRE", "include_visuals": False},
    )
    assert ndre.status_code == 400
    assert "red_edge" in ndre.json()["detail"]


def test_ndvi_reports_missing_bands_for_single_band_raster(client, single_band_raster):
    response = client.post("/api/ndvi", json={"dataset": single_band_raster, "include_visuals": False})
    assert response.status_code == 400
    assert "band_map" in response.json()["detail"]


def test_ndvi_works_without_aoi_using_raster_footprint(client, scene):
    body = client.post("/api/ndvi", json={"dataset": scene["raster"], "include_visuals": False}).json()
    assert body["aoi"] == "raster_extent"
    assert body["aoi_is_raster_extent"] is True
    assert body["statistics"]["valid_pixels"] > 0
    assert body["clip"]["georeferenced"] is True
    assert any("full raster extent" in warning for warning in body["warnings"])


def test_ndvi_on_ungeoreferenced_raster_warns_and_still_analyses(client, ungeoreferenced_raster):
    response = client.post(
        "/api/ndvi",
        json={"dataset": ungeoreferenced_raster, "band_map": {"red": 1, "nir": 3}, "include_visuals": True},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["clip"]["georeferenced"] is False
    assert body["statistics"]["valid_pixels"] > 0
    assert body["zones"]["feature_collection"]["features"] == []
    # Figures are still produced, map overlays are not.
    assert "index_map" in {asset["name"] for asset in body["assets"]}
    assert "index_overlay" not in {asset["name"] for asset in body["assets"]}


def test_ndvi_threshold_override_is_reflected_in_classes(client, scene):
    custom = client.post(
        "/api/ndvi",
        json={
            "dataset": scene["raster"],
            "aoi": scene["aoi"],
            "include_visuals": False,
            "use_cache": False,
            "thresholds": {"very_low": 0.10, "low": 0.25, "moderate": 0.50, "healthy": 0.70},
        },
    ).json()
    assert custom["health"]["thresholds"]["low"] == 0.25
    assert custom["config"]["thresholds"]["healthy"] == 0.70
    assert custom["field"]["thresholds"]["moderate"] == 0.50


def test_ndvi_writes_processed_geotiff(ndvi_result):
    processed = ndvi_result["processed_raster"]
    assert processed and processed.endswith(".tif")
    assert "ndvi" in processed.lower()
    assert Path(project_paths()["processed_data"], Path(processed).name).exists()


# --------------------------------------------------------------------------- #
# crop health
# --------------------------------------------------------------------------- #
def test_crop_health_endpoint(client, scene):
    response = client.post(
        "/api/crop-health",
        json={"dataset": scene["raster"], "aoi": scene["aoi"], "include_visuals": True},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "crop_health"
    assert body["health"]["healthy_pct"] is not None
    assert body["health"]["weak_pct"] is not None
    assert body["health"]["dominant_class"] in {"very_low", "low", "moderate", "healthy", "very_healthy"}
    assert body["interpretation"]["points"]
    keys = {asset["name"] for asset in body["assets"]}
    assert {"health_map", "health_distribution", "crop_health_overlay"} <= keys or "health_map" in keys


# --------------------------------------------------------------------------- #
# OpenCV
# --------------------------------------------------------------------------- #
def test_opencv_process_on_raster_band(client, scene):
    response = client.post(
        "/api/opencv/process",
        data={"dataset": scene["raster"], "band": 4, "operations": json.dumps(["grayscale", "blur", "otsu", "morph_open"])},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["source"]["band"] == 4
    assert body["operation_count"] == 4
    assert body["binary_output"] is True
    assert body["contour_count"] >= 1
    assert body["statistics"]["before"]["shape"] == body["statistics"]["after"]["shape"]
    assert body["georeferencing"]["crs"]
    assert {asset["name"] for asset in body["assets"]} >= {"before", "after", "before_after"}


def test_opencv_process_with_preset_and_contours(client, scene):
    response = client.post("/api/opencv/process", data={"dataset": scene["raster"], "band": 4, "preset": "clean_binary"})
    body = response.json()
    assert len(body["operations"]) == 6
    assert "contours_annotated" in {asset["name"] for asset in body["assets"]}
    assert body["contours"][0]["area_pixels"] > 0
    assert body["mask_coverage"] is not None


def test_opencv_process_accepts_uploaded_image(client):
    from PIL import Image

    buffer = io.BytesIO()
    array = np.zeros((40, 40), dtype="uint8")
    array[10:30, 10:30] = 255
    Image.fromarray(array, mode="L").save(buffer, format="PNG")
    response = client.post(
        "/api/opencv/process",
        files={"file": ("mask.png", buffer.getvalue(), "image/png")},
        data={"operations": json.dumps(["blur", "otsu"])},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["source"]["kind"] == "upload"
    assert body["contour_count"] >= 1


def test_opencv_process_validates_inputs(client, scene):
    assert client.post("/api/opencv/process", data={}).status_code == 400
    bad_op = client.post(
        "/api/opencv/process",
        data={"dataset": scene["raster"], "operations": json.dumps(["explode"])},
    )
    assert bad_op.status_code == 400
    bad_json = client.post("/api/opencv/process", data={"dataset": scene["raster"], "operations": "{not json}"})
    assert bad_json.status_code == 400
    bad_band = client.post("/api/opencv/process", data={"dataset": scene["raster"], "band": 99})
    assert bad_band.status_code == 400


# --------------------------------------------------------------------------- #
# segmentation
# --------------------------------------------------------------------------- #
def test_segmentation_endpoint_threshold(client, scene):
    response = client.post(
        "/api/segmentation",
        json={"dataset": scene["raster"], "aoi": scene["aoi"], "method": "threshold", "params": {"threshold": 0.4, "min_area_ha": 0.5}},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "classical"
    assert body["mask_coverage_pct"] > 0
    assert body["component_count"] >= 1
    assert body["segments"]
    assert body["segments_geojson"]["type"] == "FeatureCollection"
    assert body["area_ha"] > 0
    assert {asset["name"] for asset in body["assets"]} >= {"segmentation_mask", "segments_geojson"}


def test_segmentation_endpoint_multi_threshold_and_unavailable_model(client, scene):
    multi = client.post(
        "/api/segmentation",
        json={"dataset": scene["raster"], "aoi": scene["aoi"], "method": "multi_threshold", "params": {"boundaries": [0.2, 0.4, 0.6, 0.8]}},
    )
    assert multi.status_code == 200
    assert multi.json()["statistics"]["class_count"] >= 2

    model = client.post("/api/segmentation", json={"dataset": scene["raster"], "aoi": scene["aoi"], "method": "unet"})
    assert model.status_code == 400
    assert "not available" in model.json()["detail"]


# --------------------------------------------------------------------------- #
# time series
# --------------------------------------------------------------------------- #
def test_timeseries_endpoint_with_inline_observations(client):
    response = client.post(
        "/api/timeseries",
        json={
            "observations": [
                {"date": "2026-04-08", "mean": 0.42, "healthy_pct": 12.0, "weak_pct": 34.0},
                {"date": "2026-05-06", "mean": 0.51, "healthy_pct": 21.0, "weak_pct": 25.0},
                {"date": "2026-06-03", "mean": 0.64, "healthy_pct": 38.0, "weak_pct": 15.0},
            ]
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["observation_count"] == 3
    assert body["summary"]["total_change"] == pytest.approx(0.22, abs=1e-6)
    assert body["trend"]["direction"] == "increasing"
    assert body["change"]["intervals"][0]["days"] == 28
    assert body["health_trend"]["healthy_direction"] == "improving"
    assert {asset["name"] for asset in body["assets"]} == {"timeseries_chart"}


def test_timeseries_endpoint_from_computed_dataset_observations(client, scene):
    response = client.post(
        "/api/timeseries",
        json={
            "observations": [
                {"date": "2026-04-08", "dataset": scene["raster"], "aoi": scene["aoi"]},
                {"date": "2026-06-03", "dataset": scene["raster"], "aoi": scene["aoi"]},
                {"date": "2026-07-15", "dataset": scene["raster"], "aoi": scene["aoi"]},
            ],
            "include_chart": True,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["computed_observations"] == 3
    assert body["series"]["count"] == 3
    assert body["summary"]["span_days"] > 0


def test_timeseries_endpoint_from_csv_and_result_ids(client, scene, ndvi_result):
    from_csv = client.post("/api/timeseries", json={"csv": scene["table"]})
    assert from_csv.status_code == 200
    assert from_csv.json()["series"]["count"] == 21

    from_result = client.post(
        "/api/timeseries",
        json={"observations": [{"date": "2026-07-14", "result_id": ndvi_result["result_id"]}]},
    )
    assert from_result.status_code == 200
    assert from_result.json()["series"]["count"] == 1


def test_timeseries_endpoint_requires_observations(client):
    response = client.post("/api/timeseries", json={"observations": []})
    assert response.status_code == 400


# --------------------------------------------------------------------------- #
# results
# --------------------------------------------------------------------------- #
def test_results_listing_and_detail(client, ndvi_result):
    listing = client.get("/api/results").json()
    assert listing["count"] >= 1
    assert listing["by_kind"]["ndvi"] >= 1
    summary = next(item for item in listing["results"] if item["id"] == ndvi_result["result_id"])
    assert summary["kind"] == "ndvi"
    assert summary["summary"]["mean"] is not None
    assert summary["asset_count"] >= 1

    detail = client.get(f"/api/results/{ndvi_result['result_id']}").json()
    assert detail["payload"]["statistics"]["mean"] == summary["summary"]["mean"]
    filtered = client.get("/api/results", params={"kind": "ndvi", "limit": 5}).json()
    assert all(item["kind"] == "ndvi" for item in filtered["results"])


def test_results_missing_id_returns_404(client):
    assert client.get("/api/results/no-such-result").status_code == 404
    assert client.get("/api/results/no-such-result/assets/index_map.png").status_code == 404


def test_asset_download_blocks_path_traversal(client, ndvi_result):
    response = client.get(f"/api/results/{ndvi_result['result_id']}/assets/..%2F..%2Fconfig.yaml")
    assert response.status_code in {400, 404}
    response = client.get(f"/api/results/{ndvi_result['result_id']}/assets/not-an-asset.txt")
    assert response.status_code in {400, 404}


def test_static_outputs_mount_serves_assets(client, ndvi_result):
    asset = next(item for item in ndvi_result["assets"] if item["name"] == "index_map")
    response = client.get(f"/outputs/{ndvi_result['result_id']}/{asset['file']}")
    assert response.status_code == 200
    assert response.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_root_endpoint_lists_endpoints(client):
    body = client.get("/").json()
    assert body["service"] == "Vibes Lite"
    assert "/api/ndvi" in body["endpoints"]


def test_validation_errors_use_422(client):
    response = client.post("/api/ndvi", json={"dataset": ""})
    assert response.status_code in {400, 422}
