"""Real satellite ingestion tests (STAC discovery + COG pixel reads).

The catalogue and the band hosting are live third-party services, so nothing
here touches the network. Two seams are replaced:

* ``satellite._http_json`` - the single HTTP call to the STAC catalogue;
* ``satellite._remote_open`` - the only place a band file is opened, pointed at
  a local GeoTIFF instead of ``/vsicurl/https://...``.

That leaves the logic that actually matters under test - validation before any
call, the cloud threshold, the window/CRS maths, cloud masking through the Scene
Classification Layer, and above all the radiometry, because applying the wrong
offset silently rescales every index built on top of the scene.
"""
from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds

import config
import satellite

# A real Sentinel-2 window: UTM 31N, 10 m pixels, 200x200 px.
UTM_CRS = "EPSG:32631"
ORIGIN_X, ORIGIN_Y, PIXEL = 600_000.0, 5_900_000.0, 10.0
SIZE = 200
TRANSFORM = from_origin(ORIGIN_X, ORIGIN_Y, PIXEL, PIXEL)
NODATA_DN = 0

#: Reflectance (0-1) the fixture pixels are meant to represent.
TARGETS = {
    "blue": 0.062,
    "green": 0.094,
    "red": 0.090,
    "nir": 0.380,
    "rededge1": 0.151,
    "nir08": 0.403,
    "swir16": 0.203,
}
#: The band keys in the order the module writes them.
ORDER = ["blue", "green", "red", "nir", "rededge1", "nir08", "swir16"]
#: The published radiometry every Earth Search asset carries.
DECLARED = {"scale": 0.0001, "offset": -0.1}
ASSET_HOST = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/scene"


# --------------------------------------------------------------------------- #
# local COG stand-ins
# --------------------------------------------------------------------------- #
def _write_band(path, values, *, dtype="uint16", nodata=NODATA_DN, description="") -> None:
    with rasterio.open(
        path, "w", driver="GTiff",
        height=values.shape[0], width=values.shape[1], count=1,
        dtype=dtype, crs=UTM_CRS, transform=TRANSFORM, nodata=nodata,
    ) as dataset:
        dataset.write(values.astype(dtype), 1)
        dataset.set_band_description(1, description)


def _local_cogs(scene_dir, *, scl=None, offset_applied: bool = True, zero_cols=None) -> Dict[str, str]:
    """Write one local GeoTIFF per band plus an SCL, returning ``{key: path}``."""
    scene_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(11)
    shape = (SIZE, SIZE)
    paths: Dict[str, str] = {}
    for asset, reflectance in TARGETS.items():
        texture = (rng.random(shape) - 0.5) * 0.02
        values = np.clip(reflectance + texture, 0.0, 0.99)
        dn = np.round((values + (0.0 if offset_applied else 0.1)) / 0.0001).astype("uint16")
        dn[0, :] = 0  # a nodata row, as real scenes carry
        if zero_cols:
            dn[:, zero_cols[0]:zero_cols[1]] = 0
        path = scene_dir / f"{asset}.tif"
        _write_band(path, dn, description=asset.upper())
        paths[asset] = str(path)
    classes = np.full(shape, 4, dtype="uint8") if scl is None else scl
    scl_path = scene_dir / "scl.tif"
    _write_band(scl_path, classes, dtype="uint8", nodata=0, description="SCL")
    paths["scl"] = str(scl_path)
    return paths


@pytest.fixture()
def cogs(tmp_path) -> Dict[str, str]:
    return _local_cogs(tmp_path / "cogs")


def _scene(paths: Dict[str, str], *, offset_applied: bool = True, scl: bool = True, scale=None, offset=-0.1) -> Dict[str, Any]:
    """The normalised scene dict ``_scene_from_item`` would produce."""
    assets = {key: f"{ASSET_HOST}/{key}.tif" for key in ORDER}
    radiometry = {
        key: {"scale": DECLARED["scale"] if scale is None else scale, "offset": offset, "nodata": 0, "data_type": "uint16"}
        for key in ORDER
    }
    return {
        "scene_id": "S2A_TEST_20260625_0_L2A",
        "collection": "sentinel-2-l2a",
        "datetime": "2026-06-25T10:46:39.648000Z",
        "platform": "sentinel-2a",
        "cloud_cover": 0.02,
        "grid_code": "MGRS-31UFT",
        "epsg": 32631,
        "bbox": [4.9, 51.9, 6.4, 53.0],
        "thumbnail": f"{ASSET_HOST}/preview.jpg",
        "item_url": "https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2A_TEST",
        "assets": assets,
        "radiometry": radiometry,
        "boa_offset_applied": offset_applied,
        "scl_asset": f"{ASSET_HOST}/scl.tif" if scl else None,
        "missing_bands": [],
        "licence": satellite.LICENCE,
        "attribution": satellite.ATTRIBUTION,
    }


def _patch_remote(monkeypatch, paths: Dict[str, str]) -> None:
    """Serve every band open from the local GeoTIFFs instead of /vsicurl."""

    def _open(href: str, cfg):
        for key, path in paths.items():
            if href.endswith(f"{key}.tif"):
                return rasterio.Env(), path
        raise AssertionError(f"unexpected href {href}")

    monkeypatch.setattr(satellite, "_remote_open", _open)


@pytest.fixture()
def fast_satellite():
    """Isolate the module cache around each test."""
    satellite.clear_cache()
    yield
    satellite.clear_cache()


def _axes() -> tuple:
    """Longitude/latitude of the fixture raster's centre."""
    west, south, east, north = transform_bounds(
        UTM_CRS, "EPSG:4326", *rasterio.transform.array_bounds(SIZE, SIZE, TRANSFORM)
    )
    return (west + east) / 2, (south + north) / 2


def _read(paths, scene, monkeypatch, *, bands=None, mask_clouds=True):
    _patch_remote(monkeypatch, paths)
    lon, lat = _axes()
    return satellite._read_scene_window(
        scene, lat, lon, 700.0,
        bands or list(satellite.S2_BAND_KEYS),
        mask_clouds,
        config.satellite_config(),
    )


# --------------------------------------------------------------------------- #
# catalogue + status
# --------------------------------------------------------------------------- #
def test_the_catalogue_publishes_bands_licence_and_attribution():
    info = satellite.catalogue()
    assert info["enabled"] is True
    sentinel2 = next(entry for entry in info["collections"] if entry["key"] == "sentinel-2-l2a")
    assert sentinel2["supports_cloud_mask"] is True
    assert "Copernicus" in sentinel2["licence"]
    assert sentinel2["attribution"] == satellite.ATTRIBUTION
    # The descriptions must be what the platform's band resolver already reads.
    descriptions = [band["description"] for band in sentinel2["bands"]]
    assert {"B02", "B03", "B04", "B08"} <= set(descriptions)


def test_status_reports_limits_and_cache():
    status = satellite.status()
    assert status["enabled"] is True
    assert status["limits"]["max_radius_m"] > 0
    assert status["limits"]["max_pixels"] >= 10_000
    assert "cached_entries" in status["cache"]


# --------------------------------------------------------------------------- #
# validation - must never spend a catalogue call
# --------------------------------------------------------------------------- #
def _fake_stac(monkeypatch, features: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    calls: List[Dict[str, Any]] = []

    def _fetch(url, *, provider, cfg, params=None, payload=None):
        calls.append({"url": url, "payload": payload})
        return {"type": "FeatureCollection", "features": features}

    monkeypatch.setattr(satellite, "_http_json", _fetch)
    return calls


def _item(scene_id: str, cloud: float, *, datetime: str = "2026-06-25T10:46:39Z") -> Dict[str, Any]:
    assets = {key: {"href": f"{ASSET_HOST}/{key}.tif", "raster:bands": [dict(DECLARED)]} for key in ORDER}
    assets["scl"] = {"href": f"{ASSET_HOST}/scl.tif", "raster:bands": [{"scale": 1.0, "offset": 0.0}]}
    return {
        "id": scene_id,
        "collection": "sentinel-2-l2a",
        "bbox": [4.9, 51.9, 6.4, 53.0],
        "properties": {
            "datetime": datetime,
            "platform": "sentinel-2a",
            "eo:cloud_cover": cloud,
            "grid:code": "MGRS-31UFT",
            "proj:epsg": 32631,
            "earthsearch:boa_offset_applied": True,
        },
        "assets": assets,
    }


@pytest.mark.parametrize(
    "kwargs",
    [
        {"lat": 91, "lon": 5},
        {"lat": 52, "lon": 181},
        {"lat": "north", "lon": 5},
        {"lat": 52, "lon": 5, "radius_m": -1},
        {"lat": 52, "lon": 5, "radius_m": "wide"},
        {"lat": 52, "lon": 5, "days": 0},
        {"lat": 52, "lon": 5, "days": "soon"},
        {"lat": 52, "lon": 5, "max_cloud": "lots"},
        {"lat": 52, "lon": 5, "limit": "many"},
        {"lat": 52, "lon": 5, "collection": "landsat-9"},
    ],
)
def test_bad_input_is_rejected_without_calling_the_catalogue(fast_satellite, monkeypatch, kwargs):
    calls = _fake_stac(monkeypatch, [_item("S2A_ONE", 1.0)])
    with pytest.raises(satellite.SatelliteError):
        satellite.search_scenes(**kwargs)
    assert calls == []


def test_the_provider_can_be_switched_off_and_says_so(monkeypatch):
    base = config.satellite_config()
    monkeypatch.setattr(satellite, "satellite_config", lambda: {**base, "enabled": False})
    with pytest.raises(satellite.SatelliteDisabled) as error:
        satellite.search_scenes(52.6, 5.6)
    assert "VIBES_SATELLITE_ENABLED" in str(error.value)
    assert error.value.status_code == 503


def test_an_unreachable_catalogue_is_a_503_not_an_empty_list(fast_satellite, monkeypatch):
    import urllib.error

    def _boom(*_, **__):
        raise urllib.error.URLError("network is down")

    monkeypatch.setattr(satellite.urllib.request, "urlopen", _boom)
    with pytest.raises(satellite.SatelliteUnavailable) as error:
        satellite.search_scenes(52.6, 5.6)
    assert error.value.status_code == 503
    assert "unreachable" in str(error.value)


# --------------------------------------------------------------------------- #
# scene discovery
# --------------------------------------------------------------------------- #
def test_search_normalises_scenes_and_sorts_least_cloudy_first(fast_satellite, monkeypatch):
    calls = _fake_stac(monkeypatch, [
        _item("S2A_CLOUDY", 44.0),
        _item("S2A_CLEAR", 1.5),
        _item("S2A_MID", 12.0),
    ])
    result = satellite.search_scenes(52.6, 5.6, radius_m=700, days=120, max_cloud=50, limit=5)
    assert [scene["scene_id"] for scene in result["scenes"]] == ["S2A_CLEAR", "S2A_MID", "S2A_CLOUDY"]
    first = result["scenes"][0]
    assert first["datetime"] == "2026-06-25T10:46:39Z"
    assert first["cloud_cover"] == 1.5
    assert first["epsg"] == 32631
    assert set(first["assets"]) == set(ORDER)
    assert first["scl_asset"].endswith("scl.tif")
    assert first["missing_bands"] == []
    assert first["licence"] == satellite.LICENCE
    assert first["boa_offset_applied"] is True
    assert result["radius_clamped"] is False
    assert result["attribution"] == satellite.ATTRIBUTION
    # the query extension, not CQL2, is what this catalogue actually implements
    assert calls and calls[0]["payload"]["query"] == {"eo:cloud_cover": {"lte": 50.0}}


def test_the_cloud_threshold_holds_even_if_the_catalogue_ignores_it(fast_satellite, monkeypatch):
    """A catalogue that drops the query filter must not leak cloudy scenes through."""
    _fake_stac(monkeypatch, [_item("S2A_CLEAR", 2.0), _item("S2A_CLOUDY", 80.0)])
    result = satellite.search_scenes(52.6, 5.6, max_cloud=10, limit=5)
    assert [scene["scene_id"] for scene in result["scenes"]] == ["S2A_CLEAR"]
    assert any("above the 10% cloud threshold" in note for note in result["warnings"])


def test_an_over_large_radius_is_clamped_and_disclosed(fast_satellite, monkeypatch):
    _fake_stac(monkeypatch, [])
    result = satellite.search_scenes(52.6, 5.6, radius_m=10_000_000)
    assert result["radius_clamped"] is True
    assert result["radius_m"] == float(config.satellite_config()["max_radius_m"])


def test_repeat_searches_are_served_from_cache(fast_satellite, monkeypatch):
    calls = _fake_stac(monkeypatch, [_item("S2A_CLEAR", 2.0)])
    first = satellite.search_scenes(52.6, 5.6, radius_m=500, days=30, max_cloud=20, limit=3)
    second = satellite.search_scenes(52.6, 5.6, radius_m=500, days=30, max_cloud=20, limit=3)
    assert len(calls) == 1
    assert first["cached"] is False and second["cached"] is True


def test_a_catalogue_without_features_is_not_treated_as_no_scenes(fast_satellite, monkeypatch):
    monkeypatch.setattr(satellite, "_http_json", lambda *_, **__: {"nonsense": True})
    with pytest.raises(satellite.SatelliteUnavailable):
        satellite.search_scenes(52.6, 5.6)


# --------------------------------------------------------------------------- #
# geometry + host allow-list
# --------------------------------------------------------------------------- #
def test_the_search_box_always_contains_the_requested_radius():
    west, south, east, north = satellite._aoi_bbox(52.6, 5.6, 800.0)
    centre_lon, centre_lat = 5.6, 52.6
    assert west < centre_lon < east and south < centre_lat < north
    for lon, lat in [(west, south), (east, north), (west, north), (east, south)]:
        d_lat = (lat - centre_lat) * 111_320.0
        d_lon = (lon - centre_lon) * 111_320.0 * np.cos(np.radians(centre_lat))
        assert np.hypot(d_lat, d_lon) >= 800.0 - 1.0


def test_pixels_are_only_read_from_the_configured_hosts():
    cfg = config.satellite_config()
    with pytest.raises(satellite.SatelliteUpstreamError) as error:
        satellite._remote_open("https://evil.example.com/red.tif", cfg)
    assert "not in the configured asset host list" in str(error.value)
    assert error.value.status_code == 502


def test_reading_from_an_allowed_host_is_permitted():
    cfg = config.satellite_config()
    _env, path = satellite._remote_open(f"https://{cfg['asset_hosts'][0]}/red.tif", cfg)
    assert path.startswith("/vsicurl/https://")
    assert cfg["asset_hosts"][0] in path


# --------------------------------------------------------------------------- #
# pixel reads
# --------------------------------------------------------------------------- #
def test_reads_true_reflectance_and_never_double_applies_the_offset(fast_satellite, cogs, monkeypatch):
    """The published offset must NOT be reapplied when the publisher already did."""
    read = _read(cogs, _scene(cogs), monkeypatch)
    red, nir = read["arrays"]["red"], read["arrays"]["nir"]
    valid = red != satellite._NODATA
    assert valid.sum() > 0
    assert red[valid].mean() == pytest.approx(TARGETS["red"], abs=0.02)
    assert nir[valid].mean() == pytest.approx(TARGETS["nir"], abs=0.02)
    # The declared offset is recorded but neutralised, which is the whole point.
    assert read["scales"]["red"] == (0.0001, 0.0)
    assert read["offset_applied"] is True
    assert read["stats"]["red"]["min"] > 0.0
    assert read["stats"]["nir"]["mean"] == pytest.approx(TARGETS["nir"], abs=0.02)


def test_the_declared_offset_is_applied_when_the_publisher_did_not(tmp_path, monkeypatch, fast_satellite):
    paths = _local_cogs(tmp_path / "plain", offset_applied=False)
    read = _read(paths, _scene(paths, offset_applied=False), monkeypatch)
    red, nir = read["arrays"]["red"], read["arrays"]["nir"]
    valid = red != satellite._NODATA
    assert read["offset_applied"] is False
    assert read["scales"]["red"] == (0.0001, -0.1)
    assert red[valid].mean() == pytest.approx(TARGETS["red"], abs=0.02)
    assert nir[valid].mean() == pytest.approx(TARGETS["nir"], abs=0.02)


def test_an_unpublished_scale_is_refused_rather_than_assumed(fast_satellite, cogs, monkeypatch):
    scene = _scene(cogs)
    # Nothing published and nothing in the file: no basis for reflectance at all.
    scene["radiometry"] = {key: {"scale": None, "offset": None} for key in ORDER}
    with pytest.raises(satellite.SatelliteError) as error:
        _read(cogs, scene, monkeypatch)
    assert "refusing to guess the radiometry" in str(error.value)


def test_an_identity_scale_is_refused_rather_than_read_as_reflectance(fast_satellite, cogs, monkeypatch):
    scene = _scene(cogs, scale=1.0, offset=0.0)
    with pytest.raises(satellite.SatelliteError) as error:
        _read(cogs, scene, monkeypatch)
    assert "identity scale" in str(error.value)


def test_scl_cloud_is_masked_and_clear_ground_survives(fast_satellite, tmp_path, monkeypatch):
    classes = np.full((SIZE, SIZE), 4, dtype="uint8")
    classes[0:100, :] = 9  # high-probability cloud over the northern half of the scene
    paths = _local_cogs(tmp_path / "cloudy", scl=classes)
    read = _read(paths, _scene(paths), monkeypatch)
    red = read["arrays"]["red"]
    masked = red == satellite._NODATA
    assert read["cloud_masked"] is True
    # the field window sits inside the scene, so about half of it is cloud
    assert 0.25 < masked.mean() < 0.75
    assert masked[0, :].all()  # north edge of the window is cloud
    assert (red[-1, :] != satellite._NODATA).sum() > 100  # south edge is clear
    assert 0.25 < read["valid_fraction"] < 0.75
    # A DN of 0 left unmasked would read as exactly 0.0 reflectance.
    assert not np.isclose(red[red != satellite._NODATA], 0.0).any()


def test_nodata_digital_numbers_inside_the_window_are_masked(fast_satellite, tmp_path, monkeypatch):
    paths = _local_cogs(tmp_path / "holes", zero_cols=(100, 120))
    read = _read(paths, _scene(paths), monkeypatch)
    red = read["arrays"]["red"]
    assert (red == satellite._NODATA).any()
    assert read["valid_fraction"] < 1.0
    assert not np.isclose(red[red != satellite._NODATA], 0.0).any()


def test_a_fully_masked_scene_is_a_named_error_not_an_empty_raster(fast_satellite, tmp_path, monkeypatch):
    paths = _local_cogs(tmp_path / "allcloud", scl=np.full((SIZE, SIZE), 9, dtype="uint8"))
    with pytest.raises(satellite.SatelliteError) as error:
        _read(paths, _scene(paths), monkeypatch)
    assert "entirely cloud" in str(error.value)


def test_without_a_cloud_layer_the_omission_is_disclosed(fast_satellite, cogs, monkeypatch):
    read = _read(cogs, _scene(cogs, scl=False), monkeypatch)
    assert read["cloud_masked"] is False
    assert any("no Scene Classification Layer" in note for note in read["warnings"])


def test_a_field_outside_the_scene_is_reported(fast_satellite, cogs, monkeypatch):
    _patch_remote(monkeypatch, cogs)
    with pytest.raises(satellite.SatelliteError):
        satellite._read_scene_window(
            _scene(cogs), 10.0, 10.0, 400.0, list(satellite.S2_BAND_KEYS), True, config.satellite_config()
        )


def test_a_large_window_is_decimated_to_the_pixel_budget(fast_satellite, cogs, monkeypatch):
    base = config.satellite_config()
    monkeypatch.setattr(satellite, "satellite_config", lambda: {**base, "max_pixels": 2_500})
    _patch_remote(monkeypatch, cogs)
    lon, lat = _axes()
    read = satellite._read_scene_window(
        _scene(cogs), lat, lon, 700.0, list(satellite.S2_BAND_KEYS), True, satellite.satellite_config()
    )
    assert read["decimated"] is True
    assert read["shape"][0] * read["shape"][1] <= 2_500
    assert any("pixel budget" in note for note in read["warnings"])


# --------------------------------------------------------------------------- #
# the stored dataset
# --------------------------------------------------------------------------- #
def test_fetch_scene_writes_a_real_dataset_with_provenance(fast_satellite, monkeypatch, tmp_path, cogs):
    _patch_remote(monkeypatch, cogs)
    monkeypatch.setattr(satellite, "ensure_directories", lambda: {
        "raw_data": tmp_path, "processed_data": tmp_path, "outputs": tmp_path, "root": tmp_path,
    })
    monkeypatch.setattr(satellite, "_resolve_scene", lambda *a, **k: _scene(cogs))

    lon, lat = _axes()
    out = satellite.fetch_scene(lat, lon, radius_m=700, days=90, max_cloud=10)

    stored = tmp_path / out["dataset"]
    assert stored.exists() and out["cached"] is False
    assert out["scene"]["scene_id"] == "S2A_TEST_20260625_0_L2A"
    assert out["bands"][:4] == ["B02", "B03", "B04", "B08"]
    assert out["provenance"]["SATELLITE_ITEM"] == "S2A_TEST_20260625_0_L2A"
    assert "Copernicus" in out["provenance"]["LICENCE"]
    assert out["radiometry"]["boa_offset_already_applied_by_publisher"] is True
    assert "already applied" in out["provenance"]["RADIOMETRY"]

    with rasterio.open(stored) as dataset:
        assert dataset.crs.to_string() == UTM_CRS
        assert dataset.nodata == satellite._NODATA
        assert dataset.descriptions[:4] == ("B02", "B03", "B04", "B08")
        assert str(dataset.tags().get("SATELLITE_ITEM")) == "S2A_TEST_20260625_0_L2A"
        # the stored band is already reflectance, so it must declare no scaling
        assert float(dataset.scales[0]) == 1.0
        assert float(dataset.offsets[0]) == 0.0
        red = dataset.read(3)
        valid = red != satellite._NODATA
        assert red[valid].mean() == pytest.approx(TARGETS["red"], abs=0.02)

    again = satellite.fetch_scene(lat, lon, radius_m=700, days=90, max_cloud=10)
    assert again["cached"] is True
    assert again["dataset"] == out["dataset"]
    # A cache hit must answer with the same shape, not a reduced one.
    assert again["bands"] == out["bands"]
    assert again["reflectance"] == out["reflectance"]
    assert again["radiometry"]["effective"] == out["radiometry"]["effective"]
    assert again["usable_fraction"] == out["usable_fraction"]
    assert again["provenance"]["SATELLITE_ITEM"] == out["provenance"]["SATELLITE_ITEM"]


def test_a_cache_hit_without_its_record_is_rebuilt_not_truncated(fast_satellite, monkeypatch, tmp_path, cogs):
    _patch_remote(monkeypatch, cogs)
    monkeypatch.setattr(satellite, "ensure_directories", lambda: {
        "raw_data": tmp_path, "processed_data": tmp_path, "outputs": tmp_path, "root": tmp_path,
    })
    monkeypatch.setattr(satellite, "_resolve_scene", lambda *a, **k: _scene(cogs))
    lon, lat = _axes()
    first = satellite.fetch_scene(lat, lon, radius_m=700, days=90, max_cloud=10)

    # Simulate a scene stored before the fetch record existed.
    satellite._sidecar_path(tmp_path, first["dataset"]).unlink()
    again = satellite.fetch_scene(lat, lon, radius_m=700, days=90, max_cloud=10)
    assert again["cached"] is True
    assert again["provenance"]["SATELLITE_ITEM"] == "S2A_TEST_20260625_0_L2A"
    assert again["usable_fraction"] is not None
    assert again["bands"][:4] == ["B02", "B03", "B04", "B08"]
    assert any("predates" in note for note in again["warnings"])


def test_the_processing_version_is_part_of_the_dataset_name():
    assert satellite._PROCESSING_VERSION
    name = satellite._dataset_name("S2A_TEST_20260625_0_L2A", 52.6, 5.6, 700.0, list(satellite.S2_BAND_KEYS), True)
    assert name.startswith("sentinel2_S2A_TEST_20260625_0_L2A_") and name.endswith(".tif")
    other = satellite._dataset_name("S2A_TEST_20260625_0_L2A", 52.7, 5.6, 700.0, list(satellite.S2_BAND_KEYS), True)
    assert other != name
    masked = satellite._dataset_name("S2A_TEST_20260625_0_L2A", 52.6, 5.6, 700.0, list(satellite.S2_BAND_KEYS), False)
    assert masked != name


def test_unknown_band_keys_are_rejected(fast_satellite, monkeypatch):
    calls = _fake_stac(monkeypatch, [_item("S2A_ONE", 1.0)])
    with pytest.raises(satellite.SatelliteError) as error:
        satellite.fetch_scene(52.6, 5.6, bands=["red", "ultraviolet"])
    assert "Unknown band key" in str(error.value)
    assert calls == []


def test_no_usable_scene_is_explained(fast_satellite, monkeypatch):
    _fake_stac(monkeypatch, [])
    with pytest.raises(satellite.SatelliteError) as error:
        satellite.fetch_scene(52.6, 5.6, days=30, max_cloud=10)
    assert "No Sentinel-2" in str(error.value)


# --------------------------------------------------------------------------- #
# API surface
# --------------------------------------------------------------------------- #
def test_api_catalogue_scenes_and_fetch(client, monkeypatch):
    catalogue = client.get("/api/satellite/catalogue")
    assert catalogue.status_code == 200
    assert catalogue.json()["collections"][0]["licence"]

    _fake_stac(monkeypatch, [_item("S2A_CLEAR", 1.0)])
    scenes = client.get("/api/satellite/scenes", params={"lat": 52.6, "lon": 5.6, "radius_m": 700, "max_cloud": 20})
    assert scenes.status_code == 200
    body = scenes.json()
    assert body["count"] == 1
    assert body["scenes"][0]["scene_id"] == "S2A_CLEAR"

    monkeypatch.setattr(satellite, "fetch_scene", lambda *a, **k: {
        "dataset": "sentinel2_S2A_CLEAR_abc12345.tif",
        "path": "/tmp/nowhere.tif",
        "cached": False,
        "scene": _scene({}),
        "bands": ["B02", "B03", "B04", "B08"],
        "shape": [180, 180],
        "crs": "EPSG:32631",
        "provenance": {"SATELLITE_ITEM": "S2A_CLEAR"},
        "warnings": [],
    })
    fetch = client.post("/api/satellite/fetch", json={"lat": 52.6, "lon": 5.6, "radius_m": 700})
    assert fetch.status_code == 201
    payload = fetch.json()
    assert payload["dataset"].endswith(".tif")
    assert payload["dataset_detail"]["synthetic"] is False
    assert payload["dataset_detail"]["band_count"] == 4
    assert payload["next"]["analyse"]["body"]["dataset"] == payload["dataset"]


def test_api_fetch_validates_coordinates(client):
    assert client.post("/api/satellite/fetch", json={"lat": 200, "lon": 5.6}).status_code == 422
    assert client.post("/api/satellite/fetch", json={"lat": 52.6, "lon": 5.6, "radius_m": -5}).status_code == 422


def test_health_advertises_satellite_capability(client):
    body = client.get("/api/health").json()
    assert "satellite" in body["capabilities"]
    assert "sentinel-2-l2a" in body["capabilities"]["satellite"]["collections"]


def test_a_disabled_provider_surfaces_as_503_over_http(client, monkeypatch):
    base = config.satellite_config()
    monkeypatch.setattr(satellite, "satellite_config", lambda: {**base, "enabled": False})
    response = client.get("/api/satellite/scenes", params={"lat": 52.6, "lon": 5.6})
    assert response.status_code == 503
    assert "VIBES_SATELLITE_ENABLED" in response.json()["detail"]
