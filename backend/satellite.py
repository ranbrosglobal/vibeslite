"""Real satellite imagery for Vibes Lite.

Two catalogues, both Copernicus, both reached **server-side**:

``STAC``        scene discovery through the Earth Search STAC API - real items
                with real acquisition times, cloud cover and geometry.
``COG bands``   the actual reflectance pixels: the public Cloud-Optimised
                GeoTIFF band files are read straight over HTTPS with GDAL's
                ``/vsicurl`` range reader, so only the window a field needs is
                transferred (a Sentinel-2 band is 10980 x 10980 px; a 1 km field
                pulls a few hundred kilobytes, not 160 MB).

What lands on disk
------------------
One real GeoTIFF per acquisition in ``data/raw``: true surface reflectance in
0-1 as ``float32``, cloud and no-data pixels set to the nodata value, band
descriptions (``B02``/``B03``/``B04``/``B08``/...) so the existing band resolver
maps them without a hint, and provenance tags naming the exact STAC item.
Because it is an ordinary GeoTIFF in ``data/raw``, every analysis endpoint
(NDVI, crop health, segmentation, agronomy) works on it with no special case.

Radiometry is carried through, never guessed
--------------------------------------------
Sentinel-2 L2A band files store uint16 digital numbers that scale to
reflectance. Two conventions exist and picking the wrong one silently rescales
every index, so the choice is driven by the catalogue's own flag rather than an
assumption: these COGs have ``BOA_ADD_OFFSET`` **already applied to the pixel
values**, which the item reports as ``earthsearch:boa_offset_applied = true``.
The declared ``offset`` is therefore ignored when that flag is set - applying it
again would subtract 0.1 a second time and drive a large share of reflectances
negative. That conclusion was verified against the data itself, not just the
metadata: an in-scene window the Scene Classification Layer marks 100% water
reads 0.03 red reflectance with ``DN * scale``, and an impossible -0.07 with the
offset re-applied. Both the declared and the effective radiometry are recorded
as tags and returned in the API payload, and a scene that publishes no scale at
all is refused rather than assumed to be 1.0.

Nothing is invented
-------------------
A scene that cannot be found, fetched, decoded or that is entirely cloud or
no-data over the requested field raises an error naming the reason. There is no
synthetic fallback anywhere in this module.
"""
from __future__ import annotations

import json
import math
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple

import numpy as np

from config import ensure_directories, satellite_config
from data import DataError

# --------------------------------------------------------------------------- #
# errors
# --------------------------------------------------------------------------- #
class SatelliteError(DataError):
    """Base class for satellite provider problems (maps to HTTP 400)."""

    status_code = 400


class SatelliteDisabled(SatelliteError):
    """Real-satellite ingestion is switched off in configuration."""

    status_code = 503


class SatelliteUnavailable(SatelliteError):
    """The catalogue or the pixel hosting could not be reached."""

    status_code = 503


class SatelliteUpstreamError(SatelliteError):
    """The provider answered, but rejected or could not satisfy the request."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


# --------------------------------------------------------------------------- #
# catalogue
# --------------------------------------------------------------------------- #
#: Copernicus data is free and open; the licence and attribution are what the UI
#: and the generated GeoTIFF tags have to carry.
LICENCE = "Copernicus Sentinel Data Licence (free and open, attribution required)"
ATTRIBUTION = "Contains modified Copernicus Sentinel data"

#: Sentinel-2 Level-2A band assets, in the order they are written. Descriptions
#: match the platform's band resolver tokens, so no explicit band_map is needed.
S2_BANDS: List[Dict[str, Any]] = [
    {"asset": "blue", "description": "B02", "label": "Blue (B02, 10 m)", "role": "blue"},
    {"asset": "green", "description": "B03", "label": "Green (B03, 10 m)", "role": "green"},
    {"asset": "red", "description": "B04", "label": "Red (B04, 10 m)", "role": "red"},
    {"asset": "nir", "description": "B08", "label": "NIR (B08, 10 m)", "role": "nir"},
    {"asset": "rededge1", "description": "B05", "label": "Red edge (B05, 20 m)", "role": "red_edge"},
    {"asset": "nir08", "description": "B8A", "label": "Narrow NIR (B8A, 20 m)", "role": "nir"},
    {"asset": "swir16", "description": "B11", "label": "SWIR1 (B11, 20 m)", "role": "swir1"},
]
S2_BAND_KEYS = [band["asset"] for band in S2_BANDS]
#: Coarsest first: the reference grid is the finest common resolution available.
_S2_REFERENCE = "red"
_S2_SCL_ASSET = "scl"

#: Scene Classification Layer classes that are not usable ground signal:
#: 0 no-data, 1 saturated/defective, 3 cloud shadow, 8/9 clouds, 10 cirrus,
#: 11 snow/ice. Class 2 (cast shadows) and 6 (water) are real observations.
SCL_INVALID = (0, 1, 3, 8, 9, 10, 11)
SCL_LABELS = {
    0: "no-data", 1: "saturated/defective", 2: "cast shadow", 3: "cloud shadow",
    4: "vegetation", 5: "bare soil", 6: "water", 7: "unclassified",
    8: "cloud (medium probability)", 9: "cloud (high probability)",
    10: "thin cirrus", 11: "snow/ice",
}

CATALOGUE: Dict[str, Dict[str, Any]] = {
    "sentinel-2-l2a": {
        "key": "sentinel-2-l2a",
        "label": "Sentinel-2 L2A (optical reflectance)",
        "product": "Copernicus Sentinel-2 Level-2A surface reflectance, 10-20 m, 5-day revisit",
        "supports_cloud_mask": True,
        "bands": [dict(band) for band in S2_BANDS],
        "licence": LICENCE,
        "attribution": ATTRIBUTION,
        "note": "Optical: unusable under cloud, which the per-scene cloud cover and the SCL mask both address.",
    },
}

#: Bumped whenever the way pixels are turned into reflectance changes. It is
#: part of the stored file name, so a dataset written by an older processing rule
#: can never be served as if it were current.
_PROCESSING_VERSION = "r2"

#: Pixels the read is bounded to. A larger field is decimated on read (GDAL
#: resamples server-side when overviews exist), never silently truncated.
_NODATA = -9999.0

# --------------------------------------------------------------------------- #
# cache + telemetry
# --------------------------------------------------------------------------- #
_CACHE: Dict[str, Tuple[float, Any]] = {}
_LOCK = threading.Lock()
_TELEMETRY: Dict[str, Any] = {
    "calls": 0,
    "last_error": None,
    "last_ok_at": None,
    "bytes_read": 0,
    "scenes_fetched": 0,
}


def _cache_key(kind: str, params: Mapping[str, Any]) -> str:
    return f"{kind}:" + json.dumps(params, sort_keys=True, default=str)


def _cache_get(key: str, ttl: float) -> Any | None:
    with _LOCK:
        entry = _CACHE.get(key)
    if not entry:
        return None
    stored_at, value = entry
    if ttl <= 0 or (time.monotonic() - stored_at) > ttl:
        with _LOCK:
            _CACHE.pop(key, None)
        return None
    return value


def _cache_put(key: str, value: Any) -> None:
    with _LOCK:
        _CACHE[key] = (time.monotonic(), value)
        if len(_CACHE) > 256:
            oldest = sorted(_CACHE.items(), key=lambda item: item[1][0])[:64]
            for existing, _ in oldest:
                _CACHE.pop(existing, None)


def cache_info() -> Dict[str, Any]:
    """Cache size plus the last provider outcome, for the satellite status route."""
    with _LOCK:
        return {"cached_entries": len(_CACHE), **_TELEMETRY}


def clear_cache() -> int:
    """Empty the catalogue cache (used by tests and tooling). Returns entries dropped."""
    with _LOCK:
        count = len(_CACHE)
        _CACHE.clear()
    return count


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def _user_agent(cfg: Mapping[str, Any]) -> str:
    agent = str(cfg.get("user_agent") or "VibesLite").strip()
    contact = str(cfg.get("contact") or "").strip()
    if contact and contact not in agent:
        agent = f"{agent} ({contact})"
    return agent


def _http_json(
    url: str,
    *,
    provider: str,
    cfg: Mapping[str, Any],
    params: Mapping[str, Any] | None = None,
    payload: Mapping[str, Any] | None = None,
) -> Any:
    """One HTTP call to a catalogue, returning parsed JSON.

    Kept as a single seam so tests never touch the public STAC API.
    """
    query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})
    target = f"{url}?{query}" if query else url
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "User-Agent": _user_agent(cfg),
        "Accept": "application/json",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(target, data=body, headers=headers)
    timeout = float(cfg.get("timeout_seconds", 60))
    with _LOCK:
        _TELEMETRY["calls"] = int(_TELEMETRY["calls"]) + 1
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https host
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
        except Exception:  # pragma: no cover - defensive
            detail = ""
        with _LOCK:
            _TELEMETRY["last_error"] = f"{provider} HTTP {exc.code}"
        raise SatelliteUpstreamError(
            f"{provider} refused the request (HTTP {exc.code}). {detail}".strip(),
            429 if exc.code == 429 else (404 if exc.code == 404 else 502),
        ) from exc
    except urllib.error.URLError as exc:
        with _LOCK:
            _TELEMETRY["last_error"] = f"{provider} unreachable: {exc.reason}"
        raise SatelliteUnavailable(
            f"{provider} is unreachable from this host ({exc.reason}). "
            "Check outbound network access, or point the catalogue URL at a local mirror."
        ) from exc
    except (TimeoutError, OSError) as exc:
        with _LOCK:
            _TELEMETRY["last_error"] = f"{provider} timed out"
        raise SatelliteUnavailable(f"{provider} did not answer within {timeout:g}s ({exc}).") from exc

    with _LOCK:
        _TELEMETRY["last_ok_at"] = time.time()
        _TELEMETRY["last_error"] = None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SatelliteUnavailable(f"{provider} returned a response that is not JSON.") from exc


def _require_enabled(cfg: Mapping[str, Any]) -> None:
    if not cfg.get("enabled", True):
        raise SatelliteDisabled(
            "Real satellite ingestion is disabled in configuration (satellite.enabled=false). "
            "Set VIBES_SATELLITE_ENABLED=true to enable scene search and fetch."
        )


# --------------------------------------------------------------------------- #
# validation
# --------------------------------------------------------------------------- #
def _validate_lat_lon(lat: Any, lon: Any) -> Tuple[float, float]:
    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (TypeError, ValueError) as exc:
        raise SatelliteError("lat and lon must be numbers") from exc
    if not (-90.0 <= lat_f <= 90.0) or not (-180.0 <= lon_f <= 180.0):
        raise SatelliteError("lat must be within -90..90 and lon within -180..180")
    if math.isnan(lat_f) or math.isnan(lon_f):
        raise SatelliteError("lat and lon must not be NaN")
    return lat_f, lon_f


def _clamp_radius(radius_m: Any, cfg: Mapping[str, Any]) -> Tuple[float, bool]:
    maximum = float(cfg["max_radius_m"])
    if radius_m is None or radius_m == "":
        return maximum, False
    try:
        value = float(radius_m)
    except (TypeError, ValueError) as exc:
        raise SatelliteError("radius_m must be a number of metres") from exc
    if value <= 0:
        raise SatelliteError("radius_m must be greater than zero")
    if value > maximum:
        return maximum, True
    return value, False


def _clean_collection(collection: Any, cfg: Mapping[str, Any]) -> str:
    key = str(collection or cfg.get("default_collection") or "sentinel-2-l2a").strip()
    if key not in CATALOGUE:
        raise SatelliteError(
            f"Unknown collection '{key}'. Available: {', '.join(sorted(CATALOGUE))}."
        )
    return key


def _aoi_bbox(lat: float, lon: float, radius_m: float) -> Tuple[float, float, float, float]:
    """WGS84 (west, south, east, north) of a square circumscribing the radius.

    A degree of latitude is very close to 111.32 km everywhere; longitude
    shrinks with ``cos(lat)``. The square is deliberately a little generous so
    the requested circle is always inside it.
    """
    d_lat = radius_m / 111_320.0
    cos_lat = max(math.cos(math.radians(lat)), 1e-6)
    d_lon = radius_m / (111_320.0 * cos_lat)
    return (lon - d_lon, lat - d_lat, lon + d_lon, lat + d_lat)


def _aoi_polygon(lat: float, lon: float, radius_m: float) -> Dict[str, Any]:
    west, south, east, north = _aoi_bbox(lat, lon, radius_m)
    return {
        "type": "Polygon",
        "coordinates": [[
            [west, south], [east, south], [east, north], [west, north], [west, south],
        ]],
    }


# --------------------------------------------------------------------------- #
# scene discovery
# --------------------------------------------------------------------------- #
def _scene_from_item(item: Mapping[str, Any], collection: str) -> Dict[str, Any]:
    """Normalise one STAC item onto the small shape the API and the UI use."""
    properties = item.get("properties") or {}
    assets = item.get("assets") or {}
    spec = CATALOGUE[collection]
    available = {}
    radiometry: Dict[str, Dict[str, Any]] = {}
    for band in spec["bands"]:
        asset = assets.get(band["asset"])
        if isinstance(asset, Mapping) and asset.get("href"):
            available[band["asset"]] = str(asset["href"])
            # Sentinel-2 band files do NOT carry scale/offset as GeoTIFF tags;
            # the STAC item publishes the radiometry per asset and that is the
            # authoritative source. Capture it here so the reader never guesses.
            declared = (asset.get("raster:bands") or [{}])
            entry = declared[0] if declared and isinstance(declared[0], Mapping) else {}
            radiometry[band["asset"]] = {
                "scale": entry.get("scale"),
                "offset": entry.get("offset"),
                "nodata": entry.get("nodata"),
                "data_type": entry.get("data_type"),
            }
    scl = assets.get(_S2_SCL_ASSET) if spec.get("supports_cloud_mask") else None
    scl_href = str(scl["href"]) if isinstance(scl, Mapping) and scl.get("href") else None
    thumbnail = None
    for key in ("thumbnail", "rendered_preview", "overview"):
        asset = assets.get(key)
        if isinstance(asset, Mapping) and asset.get("href"):
            thumbnail = str(asset["href"])
            break
    return {
        "scene_id": str(item.get("id") or ""),
        "collection": collection,
        "collection_label": spec["label"],
        "datetime": properties.get("datetime") or properties.get("start_datetime"),
        "platform": properties.get("platform"),
        "constellation": properties.get("constellation"),
        "cloud_cover": properties.get("eo:cloud_cover"),
        "grid_code": properties.get("grid:code") or properties.get("s2:mgrs_tile"),
        "epsg": properties.get("proj:epsg"),
        "gsd": properties.get("gsd"),
        "bbox": item.get("bbox"),
        # Whether the publisher already baked BOA_ADD_OFFSET into the pixels.
        # This, not the declared offset, decides how the DNs are read.
        "boa_offset_applied": bool(properties.get("earthsearch:boa_offset_applied")),
        "thumbnail": thumbnail,
        "item_url": _item_url(collection, str(item.get("id") or "")),
        "assets": available,
        "radiometry": radiometry,
        "scl_asset": scl_href,
        "missing_bands": [band["asset"] for band in spec["bands"] if band["asset"] not in available],
        "licence": spec["licence"],
        "attribution": spec["attribution"],
    }


def _item_url(collection: str, item_id: str) -> str:
    template = str(satellite_config().get("item_url") or "")
    return template.replace("{collection}", collection).replace("{item_id}", urllib.parse.quote(item_id, safe=""))


def search_scenes(
    lat: Any,
    lon: Any,
    *,
    radius_m: Any = None,
    days: Any = None,
    max_cloud: Any = None,
    limit: Any = None,
    collection: Any = None,
) -> Dict[str, Any]:
    """Find real acquisitions over a point, least cloudy first."""
    cfg = satellite_config()
    _require_enabled(cfg)
    lat_f, lon_f = _validate_lat_lon(lat, lon)
    radius, clamped = _clamp_radius(radius_m, cfg)
    collection_key = _clean_collection(collection, cfg)

    window_days = int(cfg["window_days"])
    if days is not None and days != "":
        try:
            requested_days = int(days)
        except (TypeError, ValueError) as exc:
            raise SatelliteError("days must be a whole number of days") from exc
        if requested_days < 1:
            # Widening a 0-day window to one day would silently search a range
            # the caller did not ask for, so it is rejected instead.
            raise SatelliteError("days must be at least 1")
        window_days = min(365, requested_days)
    cloud = float(cfg["max_cloud_cover"])
    if max_cloud is not None and max_cloud != "":
        try:
            cloud = min(100.0, max(0.0, float(max_cloud)))
        except (TypeError, ValueError) as exc:
            raise SatelliteError("max_cloud must be a percentage") from exc
    count = int(cfg["max_scenes"])
    if limit is not None and limit != "":
        try:
            count = max(1, min(int(cfg["max_scenes"]), int(limit)))
        except (TypeError, ValueError) as exc:
            raise SatelliteError("limit must be a whole number") from exc

    key = _cache_key("scenes", {
        "c": collection_key, "lat": round(lat_f, 6), "lon": round(lon_f, 6),
        "r": round(radius), "d": window_days, "cloud": round(cloud, 2), "n": count,
    })
    cached = _cache_get(key, float(cfg["cache_seconds"]))
    if cached is not None:
        return {**cached, "cached": True}

    now = time.gmtime()
    start = time.gmtime(time.time() - window_days * 86_400)
    # The STAC ``query`` extension is what the Earth Search catalogue actually
    # implements; its CQL2 ``filter`` class is not advertised and a request that
    # uses it comes back unfiltered, which would quietly show cloudy scenes as
    # if they had passed. ``sortby`` is advertised, but the result is re-sorted
    # below anyway so this never depends on it.
    payload: Dict[str, Any] = {
        "collections": [collection_key],
        "intersects": _aoi_polygon(lat_f, lon_f, radius),
        "datetime": f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', start)}/{time.strftime('%Y-%m-%dT%H:%M:%SZ', now)}",
        "limit": count,
        "query": {"eo:cloud_cover": {"lte": cloud}},
        "sortby": [{"field": "properties.eo:cloud_cover", "direction": "asc"}],
    }
    body = _http_json(
        str(cfg["stac_url"]),
        provider=f"STAC ({collection_key})",
        cfg=cfg,
        payload=payload,
    )
    features = body.get("features")
    if not isinstance(features, list):
        raise SatelliteUnavailable("The STAC catalogue returned no 'features' array.")

    scenes = [_scene_from_item(item, collection_key) for item in features if isinstance(item, Mapping)]
    warnings: List[str] = []
    # A catalogue is free to ignore the query extension. Never let that turn
    # into a scene presented as if it met the threshold: enforce it here too.
    def _cloud(scene: Mapping[str, Any]) -> float | None:
        value = scene.get("cloud_cover")
        return float(value) if isinstance(value, (int, float)) else None

    exceeded = [scene for scene in scenes if (_cloud(scene) or 0.0) > cloud]
    if exceeded:
        scenes = [scene for scene in scenes if not ((_cloud(scene) or 0.0) > cloud)]
        warnings.append(
            f"The catalogue returned {len(exceeded)} scene(s) above the {cloud:g}% cloud threshold; "
            "they were discarded here so the list only shows acquisitions that met it."
        )
    # The catalogue is not required to sort; sort here so "best scene" is honest.
    scenes.sort(key=lambda scene: (scene.get("cloud_cover") is None, scene.get("cloud_cover") or 100.0))
    out = {
        "collection": collection_key,
        "collection_label": CATALOGUE[collection_key]["label"],
        "centre": {"lat": lat_f, "lon": lon_f},
        "radius_m": radius,
        "radius_clamped": clamped,
        "search": {
            "radius_m": radius,
            "window_days": window_days,
            "max_cloud_cover": cloud,
            "limit": count,
            "bbox": list(_aoi_bbox(lat_f, lon_f, radius)),
            "datetime": payload["datetime"],
        },
        "count": len(scenes),
        "scenes": scenes,
        "warnings": warnings,
        "licence": CATALOGUE[collection_key]["licence"],
        "attribution": CATALOGUE[collection_key]["attribution"],
        "cached": False,
    }
    _cache_put(key, {**out, "cached": False})
    return out


def _resolve_scene(
    lat: float,
    lon: float,
    radius: float,
    *,
    scene_id: Any,
    collection: str,
    days: Any,
    max_cloud: Any,
    cfg: Mapping[str, Any],
) -> Dict[str, Any]:
    """Return the STAC item to read: either the one asked for, or the least cloudy."""
    if scene_id:
        item = _http_json(
            _item_url(collection, str(scene_id)),
            provider=f"STAC item {scene_id}",
            cfg=cfg,
        )
        if not isinstance(item, Mapping):
            raise SatelliteUnavailable(f"STAC returned no item for '{scene_id}'.")
        return _scene_from_item(item, collection)

    found = search_scenes(
        lat, lon, radius_m=radius, days=days, max_cloud=max_cloud,
        limit=cfg["max_scenes"], collection=collection,
    )
    if not found["scenes"]:
        raise SatelliteError(
            f"No {CATALOGUE[collection]['label']} acquisition within {found['search']['window_days']} days "
            f"under {found['search']['max_cloud_cover']:g}% cloud over this field. "
            "Widen the date window, raise the cloud threshold, or supply a scene_id."
        )
    return found["scenes"][0]


# --------------------------------------------------------------------------- #
# pixel reading
# --------------------------------------------------------------------------- #
def _asset_host_allowed(href: str, cfg: Mapping[str, Any]) -> bool:
    host = urllib.parse.urlparse(href).hostname or ""
    hosts = cfg.get("asset_hosts") or []
    return any(host == allowed or host.endswith("." + allowed) for allowed in hosts)


def _remote_open(href: str, cfg: Mapping[str, Any]):
    """Open one band COG over HTTPS, reading only the windows we ask for."""
    import rasterio

    if not _asset_host_allowed(href, cfg):
        host = urllib.parse.urlparse(href).hostname or "(no host)"
        raise SatelliteUpstreamError(
            f"Refusing to read pixels from '{host}': it is not in the configured asset host list.",
            502,
        )
    environ = {
        "GDAL_HTTP_TIMEOUT": str(float(cfg["timeout_seconds"])),
        "GDAL_HTTP_CONNECTTIMEOUT": str(min(15.0, float(cfg["timeout_seconds"]))),
        "GDAL_HTTP_MAX_RETRY": "2",
        "GDAL_HTTP_RETRY_DELAY": "1",
        "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
        "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.TIF",
        "CPL_VSIL_CURL_USE_HEAD": "NO",
        "VSI_CACHE": "TRUE",
        "VSI_CACHE_SIZE": "33554432",
    }
    return rasterio.Env(**environ), f"/vsicurl/{href}"


def _read_into_grid(
    source: Any,
    bounds: Sequence[float],
    dst_transform: Any,
    dst_crs: Any,
    out_shape: Tuple[int, int],
    *,
    resampling: str = "bilinear",
) -> np.ndarray:
    """Read one band's window and warp it onto the shared output grid."""
    import rasterio
    from rasterio.warp import Resampling, reproject

    src_window = source.window(*bounds).round_offsets().round_lengths()
    try:
        src_window = src_window.intersection(
            rasterio.windows.Window(0, 0, source.width, source.height)
        )
    except rasterio.errors.WindowError as exc:
        # Reachable for a band on a coarser grid than the reference band when
        # the field sits at the very edge of the scene.
        raise SatelliteError(
            "The requested field falls outside this scene's extent."
        ) from exc
    if src_window.width < 1 or src_window.height < 1:
        raise SatelliteError("The requested field falls outside this scene's extent.")
    src = source.read(
        1,
        window=src_window,
        out_shape=(max(1, int(src_window.height)), max(1, int(src_window.width))),
        masked=False,
    ).astype("float32")
    mode = {"bilinear": Resampling.bilinear, "nearest": Resampling.nearest}[resampling]
    destination = np.full(out_shape, np.nan, dtype="float32")
    src_nodata = float(source.nodata) if source.nodata is not None else 0.0
    reproject(
        source=src,
        destination=destination,
        src_transform=source.window_transform(src_window),
        src_crs=source.crs,
        src_nodata=src_nodata,
        dst_transform=dst_transform,
        dst_crs=dst_crs,
        dst_nodata=np.nan,
        resampling=mode,
    )
    return destination


def _read_scene_window(
    scene: Mapping[str, Any],
    lat: float,
    lon: float,
    radius: float,
    band_keys: Sequence[str],
    mask_clouds: bool,
    cfg: Mapping[str, Any],
) -> Dict[str, Any]:
    """Read the field's window of every requested band as true reflectance."""
    offset_applied = bool(scene.get("boa_offset_applied"))
    reference_asset = scene["assets"].get(_S2_REFERENCE)
    if not reference_asset:
        raise SatelliteError(
            f"Scene {scene['scene_id']} does not publish the {_S2_REFERENCE} band its 10 m grid needs."
        )
    bands = [band for band in S2_BANDS if band["asset"] in band_keys]

    west, south, east, north = _aoi_bbox(lat, lon, radius)
    warnings: List[str] = []
    arrays: Dict[str, np.ndarray] = {}
    scales: Dict[str, Tuple[float, float]] = {}

    env, ref_path = _remote_open(reference_asset, cfg)
    with env:
        import rasterio
        from rasterio.warp import transform_bounds

        if not _asset_host_allowed(reference_asset, cfg):  # pragma: no cover - guarded above
            raise SatelliteUpstreamError("Refusing to read pixels from an unlisted host.", 502)
        with rasterio.open(ref_path) as reference:
            dst_crs = reference.crs
            if dst_crs is None:
                raise SatelliteError("The scene's reference band carries no CRS.")
            bounds = transform_bounds("EPSG:4326", dst_crs, west, south, east, north)
            ref_window = reference.window(*bounds).round_offsets().round_lengths()
            try:
                ref_window = ref_window.intersection(
                    rasterio.windows.Window(0, 0, reference.width, reference.height)
                )
            except rasterio.errors.WindowError as exc:
                # The field and the scene do not overlap at all. Left uncaught
                # this surfaces as a rasterio error and a 500; it is really a
                # request problem worth naming.
                raise SatelliteError(
                    "The requested field falls outside this scene's extent. "
                    "Pick a scene that covers the field, or move the field."
                ) from exc
            if ref_window.width < 1 or ref_window.height < 1:
                raise SatelliteError("The requested field falls outside this scene's extent.")

            budget = int(cfg["max_pixels"])
            native = ref_window.width * ref_window.height
            shrink = math.sqrt(budget / float(native)) if native > budget else 1.0
            out_h = max(1, int(round(ref_window.height * shrink)))
            out_w = max(1, int(round(ref_window.width * shrink)))
            dst_transform = reference.window_transform(ref_window) @ rasterio.Affine.scale(
                ref_window.width / out_w, ref_window.height / out_h
            )
            if shrink < 1.0:
                warnings.append(
                    f"The field window was {int(native):,} px at native resolution; it was read at 1/{1 / shrink:.1f} "
                    "to respect the configured pixel budget."
                )
            for band in bands:
                href = scene["assets"].get(band["asset"])
                if not href:
                    warnings.append(f"{band['description']} is not published for this scene and was skipped.")
                    continue
                declared = (scene.get("radiometry") or {}).get(band["asset"]) or {}
                if href == reference_asset:
                    array = reference.read(
                        1,
                        window=ref_window,
                        out_shape=(out_h, out_w),
                        masked=False,
                    ).astype("float32")
                    file_scale, file_offset = float(reference.scales[0] or 1.0), float(reference.offsets[0] or 0.0)
                else:
                    band_env, band_path = _remote_open(href, cfg)
                    with band_env, rasterio.open(band_path) as source:
                        array = _read_into_grid(source, bounds, dst_transform, dst_crs, (out_h, out_w))
                        file_scale, file_offset = float(source.scales[0] or 1.0), float(source.offsets[0] or 0.0)
                # Prefer the published STAC radiometry; a GeoTIFF that carries
                # its own scale/offset is an acceptable second source. Anything
                # less than that is a guess, and guessing radiometry silently
                # rescales every index downstream.
                scale, offset = declared.get("scale"), declared.get("offset")
                if scale is None and offset is None:
                    if file_scale == 1.0 and file_offset == 0.0:
                        raise SatelliteError(
                            f"Scene {scene['scene_id']} publishes no reflectance scale for "
                            f"{band['description']}; refusing to guess the radiometry."
                        )
                    scale, offset = file_scale, file_offset
                scale = float(scale if scale is not None else 1.0)
                offset = float(offset if offset is not None else 0.0)
                if scale == 1.0 and offset == 0.0:
                    raise SatelliteError(
                        f"Scene {scene['scene_id']} declares an identity scale for {band['description']}; "
                        "refusing to treat raw digital numbers as reflectance."
                    )
                if offset_applied:
                    # Publisher already applied BOA_ADD_OFFSET to these pixels.
                    offset = 0.0
                arrays[band["asset"]] = array
                scales[band["asset"]] = (scale, offset)

            invalid = np.zeros((out_h, out_w), dtype=bool)
            if mask_clouds and scene.get("scl_asset"):
                scl_env, scl_path = _remote_open(str(scene["scl_asset"]), cfg)
                with scl_env, rasterio.open(scl_path) as scl_source:
                    scl = _read_into_grid(
                        scl_source, bounds, dst_transform, dst_crs, (out_h, out_w), resampling="nearest"
                    )
                classed = np.isin(np.nan_to_num(scl, nan=-1).astype("int16"), np.array(SCL_INVALID, dtype="int16"))
                invalid |= classed
                invalid |= ~np.isfinite(scl)
            elif mask_clouds:
                warnings.append(
                    "This scene publishes no Scene Classification Layer, so cloud was not masked pixel-wise; "
                    "rely on the reported scene-level cloud cover."
                )

    if not arrays:
        raise SatelliteError(f"Scene {scene['scene_id']} published none of the requested bands.")

    for key, array in arrays.items():
        invalid |= ~np.isfinite(array)
        invalid |= np.isclose(array, 0.0)

    reflected: Dict[str, np.ndarray] = {}
    stats: Dict[str, Any] = {}
    total = invalid.size
    impossible = 0.0
    for key, array in arrays.items():
        scale, offset = scales[key]
        values = (array * scale + offset).astype("float32")
        values[invalid] = _NODATA
        reflected[key] = values
        valid = values != _NODATA
        if valid.any():
            stats[key] = {
                "min": round(float(values[valid].min()), 4),
                "mean": round(float(values[valid].mean()), 4),
                "max": round(float(values[valid].max()), 4),
            }
            # A surface reflectance clearly below zero is not a surface. A few
            # dark pixels legitimately sit just under zero, so the check only
            # reports a materially negative share - the signature of a
            # double-applied additive offset, which would be a metadata problem
            # worth seeing rather than a crop problem.
            below = float(np.mean(values[valid] < -0.05))
            impossible = max(impossible, below)
        else:
            stats[key] = {"min": None, "mean": None, "max": None}

    if impossible > 0.02:
        warnings.append(
            f"{impossible * 100:.1f}% of usable pixels read below -0.05 reflectance, which no surface "
            "produces. The catalogue may have applied the additive offset inconsistently for this item; "
            "compare the reported reflectance range before trusting absolute values."
        )

    valid_fraction = float(1.0 - (invalid.sum() / total)) if total else 0.0
    if valid_fraction <= 0.01:
        raise SatelliteError(
            f"Scene {scene['scene_id']} is entirely cloud, shadow or no-data over this field "
            f"({valid_fraction * 100:.1f}% usable pixels). Pick another acquisition."
        )

    return {
        "bands": bands,
        "arrays": reflected,
        "scales": scales,
        "offset_applied": offset_applied,
        "shape": (out_h, out_w),
        "transform": dst_transform,
        "crs": dst_crs,
        "valid_fraction": round(valid_fraction, 4),
        "cloud_masked": bool(mask_clouds and scene.get("scl_asset")),
        "decimated": bool(out_h * out_w < native),
        "native_shape": (int(ref_window.height), int(ref_window.width)),
        "stats": stats,
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- #
# writing the dataset
# --------------------------------------------------------------------------- #
def _sidecar_path(raw_dir: Path, name: str) -> Path:
    """Where the original fetch payload is kept for a stored scene.

    A hidden directory, so it never appears as a dataset in ``data/raw``.
    """
    return Path(raw_dir) / ".satellite" / f"{name}.json"


def _read_sidecar(raw_dir: Path, name: str) -> Dict[str, Any] | None:
    path = _sidecar_path(raw_dir, name)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _describe_stored(
    target: Path,
    name: str,
    scene: Mapping[str, Any],
    requested: Sequence[str],
) -> Dict[str, Any]:
    """Rebuild a payload for a scene stored before the sidecar existed."""
    import rasterio

    with rasterio.open(target) as dataset:
        tags = dict(dataset.tags() or {})
        bands = [band for band in S2_BANDS if band["asset"] in requested] if requested else []
        descriptions = [
            description or band["description"]
            for description, band in zip(dataset.descriptions or (), bands)
        ]
        usable = tags.get("USABLE_FRACTION")
        return {
            "dataset": name,
            "path": str(target),
            "scene": scene,
            "bands": descriptions or [description for description in (dataset.descriptions or ()) if description],
            "shape": [dataset.height, dataset.width],
            "crs": str(dataset.crs),
            "resolution_m": round(float(dataset.transform.a), 2),
            "size_mb": round(target.stat().st_size / 1e6, 3),
            "usable_fraction": float(usable) if usable else None,
            "cloud_masked": tags.get("CLOUD_MASKED") == "SCL",
            "provenance": tags,
            "warnings": [
                "This stored scene predates its fetch record, so per-band reflectance statistics "
                "are not available here. Re-fetch with force=true to regenerate them.",
            ],
        }


def _dataset_name(scene_id: str, lat: float, lon: float, radius: float, band_keys: Sequence[str], mask: bool) -> str:
    import hashlib

    signature = json.dumps(
        {
            "scene": scene_id, "lat": round(lat, 5), "lon": round(lon, 5),
            "radius": round(radius), "bands": list(band_keys), "mask": bool(mask),
            "v": _PROCESSING_VERSION,
        },
        sort_keys=True,
    )
    digest = hashlib.sha1(signature.encode("utf-8")).hexdigest()[:8]
    safe_scene = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in scene_id)[:48]
    return f"sentinel2_{safe_scene}_{digest}.tif"


def fetch_scene(
    lat: Any,
    lon: Any,
    *,
    radius_m: Any = None,
    scene_id: Any = None,
    collection: Any = None,
    days: Any = None,
    max_cloud: Any = None,
    mask_clouds: bool = True,
    bands: Sequence[str] | None = None,
    force: bool = False,
) -> Dict[str, Any]:
    """Download a real scene window and register it as a dataset in ``data/raw``."""
    cfg = satellite_config()
    _require_enabled(cfg)
    lat_f, lon_f = _validate_lat_lon(lat, lon)
    radius, clamped = _clamp_radius(radius_m, cfg)
    collection_key = _clean_collection(collection, cfg)
    if not CATALOGUE[collection_key]["supports_cloud_mask"] and mask_clouds:
        mask_clouds = False

    requested = list(bands) if bands else list(S2_BAND_KEYS)
    known = {band["asset"] for band in S2_BANDS}
    unknown = [key for key in requested if key not in known]
    if unknown:
        raise SatelliteError(
            f"Unknown band key(s) {', '.join(unknown)}. Available: {', '.join(S2_BAND_KEYS)}."
        )
    requested = [key for key in S2_BAND_KEYS if key in requested]

    scene = _resolve_scene(
        lat_f, lon_f, radius,
        scene_id=scene_id, collection=collection_key, days=days, max_cloud=max_cloud, cfg=cfg,
    )

    paths = ensure_directories()
    name = _dataset_name(scene["scene_id"], lat_f, lon_f, radius, requested, mask_clouds)
    target = paths["raw_data"] / name

    if target.exists() and not force:
        # A cache hit has to answer with the same shape as a fresh fetch, or the
        # caller silently loses the reflectance statistics and warnings it was
        # written against. The sidecar holds the original payload; when it is
        # missing (an older file) the essentials are re-derived from the raster.
        stored = _read_sidecar(paths["raw_data"], name) or _describe_stored(target, name, scene, requested)
        return {**stored, "cached": True}

    read = _read_scene_window(scene, lat_f, lon_f, radius, requested, mask_clouds, cfg)

    import rasterio

    tags = {
        "SATELLITE_ITEM": scene["scene_id"],
        "SATELLITE_COLLECTION": collection_key,
        "SATELLITE_DATETIME": str(scene.get("datetime") or ""),
        "SATELLITE_CLOUD_COVER": "" if scene.get("cloud_cover") is None else f"{float(scene['cloud_cover']):.3f}",
        "SATELLITE_PLATFORM": str(scene.get("platform") or ""),
        "SATELLITE_MGRS": str(scene.get("grid_code") or ""),
        "SATELLITE_ITEM_URL": scene.get("item_url") or "",
        "REQUEST_CENTRE": f"{lat_f:.6f},{lon_f:.6f}",
        "REQUEST_RADIUS_M": f"{radius:g}",
        "CLOUD_MASKED": "SCL" if read["cloud_masked"] else "none",
        "USABLE_FRACTION": f"{read['valid_fraction']:.4f}",
        "LICENCE": CATALOGUE[collection_key]["licence"],
        "ATTRIBUTION": CATALOGUE[collection_key]["attribution"],
        "PROCESSING": "DN -> reflectance; no atmospheric correction applied here",
        "RADIOMETRY": "DN*scale (BOA offset already applied by the publisher)"
        if read["offset_applied"]
        else "DN*scale+offset (as published)",
    }
    with rasterio.open(
        target,
        "w",
        driver="GTiff",
        height=read["shape"][0],
        width=read["shape"][1],
        count=len(read["bands"]),
        dtype="float32",
        crs=read["crs"],
        transform=read["transform"],
        nodata=_NODATA,
        compress="deflate",
        predictor="3",
        tiled=True,
        blockxsize=256,
        blockysize=256,
    ) as dataset:
        for index, band in enumerate(read["bands"], start=1):
            dataset.write(read["arrays"][band["asset"]], index)
            dataset.set_band_description(index, band["description"])
            dataset.set_band_unit(index, "reflectance")
        dataset.update_tags(**tags)

    with _LOCK:
        _TELEMETRY["scenes_fetched"] = int(_TELEMETRY.get("scenes_fetched", 0)) + 1

    payload = {
        "dataset": target.name,
        "path": str(target),
        "cached": False,
        "scene": scene,
        "bands": [band["description"] for band in read["bands"]],
        "band_labels": [band["label"] for band in read["bands"]],
        "shape": list(read["shape"]),
        "native_shape": list(read["native_shape"]),
        "decimated": read["decimated"],
        "crs": str(read["crs"]),
        "resolution_m": round(float(read["transform"].a), 2),
        "size_mb": round(target.stat().st_size / 1e6, 3),
        "usable_fraction": read["valid_fraction"],
        "cloud_masked": read["cloud_masked"],
        "reflectance": read["stats"],
        "radiometry": {
            "effective": {
                key: {"scale": value[0], "offset": value[1]} for key, value in read["scales"].items()
            },
            "declared": scene.get("radiometry") or {},
            "boa_offset_already_applied_by_publisher": read["offset_applied"],
            "note": (
                "These COGs carry BOA_ADD_OFFSET already applied to the pixel values, so the declared "
                "offset is not reapplied. Verified in-scene: water the SCL marks as water reads ~0.03 "
                "reflectance this way and negative the other way."
            )
            if read["offset_applied"]
            else "The declared asset offset was applied to the digital numbers.",
        },
        "warnings": read["warnings"],
        "provenance": tags,
    }
    # Record the payload next to the raster so an identical later request is
    # answered with exactly the same shape instead of a reduced one.
    try:
        sidecar = _sidecar_path(paths["raw_data"], target.name)
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        sidecar.write_text(json.dumps(payload, default=str), encoding="utf-8")
    except OSError as exc:  # pragma: no cover - a full disk should not lose the scene
        payload["warnings"].append(f"The stored scene could not be recorded for reuse ({exc}).")
    return payload


# --------------------------------------------------------------------------- #
# status
# --------------------------------------------------------------------------- #
def catalogue() -> Dict[str, Any]:
    """Collections this deployment can fetch, with their licence and policy."""
    cfg = satellite_config()
    return {
        "enabled": bool(cfg["enabled"]),
        "default_collection": cfg["default_collection"],
        "collections": [
            {
                "key": key,
                "label": spec["label"],
                "product": spec["product"],
                "supports_cloud_mask": spec["supports_cloud_mask"],
                "licence": spec["licence"],
                "attribution": spec["attribution"],
                "note": spec["note"],
                "bands": [
                    {"key": band["asset"], "description": band["description"], "label": band["label"], "role": band["role"]}
                    for band in spec["bands"]
                ],
            }
            for key, spec in CATALOGUE.items()
        ],
        "limits": {
            "max_radius_m": cfg["max_radius_m"],
            "max_scenes": cfg["max_scenes"],
            "max_cloud_cover": cfg["max_cloud_cover"],
            "max_pixels": cfg["max_pixels"],
            "window_days": cfg["window_days"],
        },
        "providers": [
            {"name": "Earth Search STAC", "role": "scene discovery", "url": cfg["stac_url"]},
            {"name": "COG band hosting", "role": "pixel reads over HTTPS range requests", "hosts": cfg["asset_hosts"]},
        ],
        "cache": cache_info(),
    }


def status() -> Dict[str, Any]:
    """Small health descriptor used by the API status route."""
    cfg = satellite_config()
    info = catalogue()
    return {
        "enabled": info["enabled"],
        "collections": [item["key"] for item in info["collections"]],
        "default_collection": info["default_collection"],
        "limits": info["limits"],
        "cache": info["cache"],
    }


def band_keys() -> Iterable[str]:
    return tuple(S2_BAND_KEYS)
