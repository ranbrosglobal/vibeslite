"""Geospatial engine tests (AOI validation, clipping, masking, polygonisation)."""
from __future__ import annotations

import geopandas as gpd
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import Point, Polygon, box

import geospatial
from data import AOIError, NotFoundError, geometry_area_hectares, load_geojson, validate_aoi


def _square_field(crs="EPSG:32633", size=1000.0, x=250000.0, y=4540000.0) -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {"name": ["field_1"], "crop": ["maize"]},
        geometry=[box(x, y - size, x + size, y)],
        crs=crs,
    )


def test_validate_aoi_accepts_polygons_and_reports_area():
    result = validate_aoi(_square_field())
    assert result["feature_count"] == 1
    assert result["area_ha"] == pytest.approx(100.0, rel=0.01)  # 1 km x 1 km
    assert result["warnings"] == []
    assert "name" in result["gdf"].columns


def test_validate_aoi_rejects_non_polygonal_geometry():
    points = gpd.GeoDataFrame({"name": ["p"]}, geometry=[Point(12.0, 41.0)], crs="EPSG:4326")
    with pytest.raises(AOIError) as error:
        validate_aoi(points)
    assert "polygonal" in str(error.value)


def test_validate_aoi_repairs_invalid_geometry():
    bowtie = Polygon([(0, 0), (1, 1), (1, 0), (0, 1)])
    frame = gpd.GeoDataFrame({"name": ["bad"]}, geometry=[bowtie], crs="EPSG:4326")
    result = validate_aoi(frame)
    assert result["gdf"].geometry.is_valid.all()
    assert any("invalid geometry" in warning for warning in result["warnings"])


def test_validate_aoi_assigns_default_crs_and_drops_empty_geometries():
    frame = gpd.GeoDataFrame({"name": ["a", "b"]}, geometry=[box(12.0, 41.0, 12.01, 41.01), None])
    result = validate_aoi(frame)
    assert str(result["gdf"].crs) == "EPSG:4326"
    assert result["feature_count"] == 1
    assert result["area_ha"] > 0
    assert any("empty geometry" in warning.lower() for warning in result["warnings"])


def test_load_geojson_accepts_inline_payload():
    payload = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "inline field"},
                "geometry": {"type": "Polygon", "coordinates": [[[12.0, 41.0], [12.01, 41.0], [12.01, 41.01], [12.0, 41.01], [12.0, 41.0]]]},
            }
        ],
    }
    result = load_geojson(payload)
    assert result["feature_count"] == 1
    assert result["area_ha"] > 0
    assert result["geojson"]["type"] == "FeatureCollection"


def test_load_geojson_rejects_garbage():
    with pytest.raises(AOIError):
        load_geojson({"type": "FeatureCollection"})
    with pytest.raises(AOIError):
        load_geojson(42)


def test_geometry_area_hectares_is_metric_for_geographic_input():
    lat_lon = gpd.GeoDataFrame(
        {"name": ["lonlat field"]},
        geometry=[box(12.0, 41.0, 12.01, 41.01)],
        crs="EPSG:4326",
    )
    result = validate_aoi(lat_lon)
    # 0.01 deg at ~41 N is about 1.1 km wide, so roughly 110-120 ha
    assert 90 < result["area_ha"] < 140
    assert float(geometry_area_hectares(lat_lon).sum()) == pytest.approx(result["area_ha"], rel=0.01)


def test_pixel_area_and_crs_helpers():
    transform = from_origin(250000, 4540000, 10, 10)
    assert geospatial.pixel_area_hectares(transform) == pytest.approx(0.01)
    info = geospatial.crs_info(None)
    assert info["defined"] is False
    assert info["epsg"] is None
    assert geospatial.guess_utm_epsg(12.0, 41.0) == 32633
    assert geospatial.guess_utm_epsg(12.0, -41.0) == 32733


def test_crs_info_reports_units_for_real_crs():
    """Regression: crs_info must read pyproj units (axis_info), not linear_units."""
    projected = geospatial.crs_info(rasterio.crs.CRS.from_epsg(32633))
    assert projected["defined"] is True
    assert projected["epsg"] == 32633
    assert projected["is_projected"] is True
    assert projected["unit"].lower() in {"metre", "meter", "m"}

    geographic = geospatial.crs_info(rasterio.crs.CRS.from_epsg(4326))
    assert geographic["is_projected"] is False
    assert geographic["unit"].lower() in {"degree", "degrees", "deg"}

    # A CRS object without a direct unit attribute still resolves via axis_info.
    class Bare:
        is_projected = True
        name = "bare"

        def to_epsg(self):
            return None

    bare = geospatial.crs_info(Bare())
    assert bare["defined"] is True
    assert bare["unit"] is None


def test_clip_raster_to_aoi_returns_windowed_data(scene):
    from config import project_paths

    raster = project_paths()["raw_data"] / scene["raster"]
    aoi = gpd.read_file(project_paths()["raw_data"] / scene["aoi"])
    clip = geospatial.clip_raster_to_aoi(raster, aoi, bands=[3, 4], max_pixels=200_000)
    assert clip["array"].shape[0] == 2
    assert clip["array"].shape[1] == clip["shape"][0]
    assert clip["mask"].dtype == bool
    assert clip["mask"].mean() > 0.2
    assert clip["decimated"] is False
    assert clip["clip_bounds_lonlat"] is not None
    # Windowed read: the clip must be much smaller than the source scene.
    assert clip["shape"][0] <= 400
    assert clip["window"][2] >= clip["shape"][1]


def test_clip_raster_to_aoi_decimates_when_over_budget(scene):
    from config import project_paths

    raster = project_paths()["raw_data"] / scene["raster"]
    aoi = gpd.read_file(project_paths()["raw_data"] / scene["aoi"])
    clip = geospatial.clip_raster_to_aoi(raster, aoi, bands=[4], max_pixels=2_000)
    assert clip["decimated"] is True
    assert clip["array"].size <= 2_100
    assert clip["decimation"] > 1


def test_clip_raster_rejects_non_overlapping_aoi(scene):
    from config import project_paths

    raster = project_paths()["raw_data"] / scene["raster"]
    far_away = gpd.GeoDataFrame({"name": ["far"]}, geometry=[box(500000, 4600000, 500100, 4600100)], crs="EPSG:32633")
    with pytest.raises(geospatial.GeospatialError) as error:
        geospatial.clip_raster_to_aoi(raster, far_away, bands=[4])
    assert "outside the raster extent" in str(error.value)


def test_clip_raster_requires_crs(ungeoreferenced_raster):
    from config import project_paths

    raster = project_paths()["raw_data"] / ungeoreferenced_raster
    with pytest.raises(geospatial.GeospatialError):
        geospatial.clip_raster_to_aoi(raster, _square_field(crs="EPSG:4326"))


def test_raster_aoi_overlap_reports_fraction(scene):
    from config import project_paths
    from data import get_raster_metadata

    raster = project_paths()["raw_data"] / scene["raster"]
    metadata = get_raster_metadata(raster)
    aoi = gpd.read_file(project_paths()["raw_data"] / scene["aoi"])
    overlap = geospatial.raster_aoi_overlap(aoi, metadata, geospatial.get_crs(raster))
    assert overlap["overlap_fraction"] == pytest.approx(1.0, abs=1e-3)
    assert overlap["warnings"] == []


def test_rasterize_aoi_and_apply_mask():
    transform = from_origin(250000, 4540000, 10, 10)
    aoi = gpd.GeoDataFrame({"name": ["left half"]}, geometry=[box(250000, 4539900, 250050, 4540000)], crs="EPSG:32633")
    mask = geospatial.rasterize_aoi(aoi, out_shape=(10, 10), transform=transform)
    assert mask.shape == (10, 10)
    assert mask[:, :5].all()
    assert not mask[:, 5:].any()
    array = np.ones((10, 10), dtype="float32")
    masked = geospatial.apply_aoi_mask(array, mask)
    assert np.ma.isMaskedArray(masked)
    assert masked.mask[0, 9] is np.True_ or bool(masked.mask[0, 9])


def test_mask_to_polygons_areas_centroids_and_min_area():
    transform = from_origin(250000, 4540000, 10, 10)
    mask = np.zeros((40, 40), dtype=bool)
    mask[0:10, 0:10] = True  # 100 px = 1 ha
    mask[30, 30] = True  # single pixel
    polygons = geospatial.mask_to_polygons(mask, transform, "EPSG:32633", min_area_ha=0.05)
    assert len(polygons) == 1
    assert polygons[0]["area_ha"] == pytest.approx(1.0, rel=0.02)
    assert len(polygons[0]["centroid_lonlat"]) == 2
    assert polygons[0]["geometry_geojson"]["type"] in {"Polygon", "MultiPolygon"}
    assert geospatial.mask_to_polygons(np.zeros((5, 5), dtype=bool), transform, "EPSG:32633") == []


def test_reproject_to_lonlat_produces_wgs84_grid():
    transform = from_origin(250000, 4540000, 10, 10)
    array = np.full((50, 60), 0.6, dtype="float32")
    result = geospatial.reproject_to_lonlat(array, transform, "EPSG:32633", out_shape=(25, 30))
    assert result["array"].shape == (25, 30)
    west, south, east, north = result["bounds_lonlat"]
    assert 11.5 < west < east < 12.6
    assert 40.4 < south < north < 41.5
    assert np.isfinite(result["array"]).mean() > 0.9


def test_reproject_to_lonlat_can_downsample_large_arrays():
    transform = from_origin(250000, 4540000, 10, 10)
    array = np.random.default_rng(5).random((400, 400)).astype("float32")
    result = geospatial.reproject_to_lonlat(array, transform, "EPSG:32633", out_shape=(100, 100))
    assert result["array"].shape == (100, 100)


def test_zones_feature_collection_builds_geojson():
    transform = from_origin(250000, 4540000, 10, 10)
    mask = np.zeros((20, 20), dtype=bool)
    mask[0:5, 0:5] = True
    zones = geospatial.mask_to_polygons(mask, transform, "EPSG:32633", properties={"label": "weak"})
    collection = geospatial.zones_feature_collection(zones, zone_key="label")
    assert collection["type"] == "FeatureCollection"
    assert len(collection["features"]) == 1
    assert collection["features"][0]["properties"]["label"] == "weak"


def test_transform_bounds_lonlat_and_missing_dataset():
    bounds = geospatial.transform_bounds_lonlat([250000, 4539000, 251000, 4540000], "EPSG:32633")
    assert bounds is not None and len(bounds) == 4
    assert geospatial.transform_bounds_lonlat([0, 0, 1, 1], None) is None
    with pytest.raises(NotFoundError):
        from data import get_raster_metadata

        get_raster_metadata("/tmp/definitely-not-here-1234.tif")
