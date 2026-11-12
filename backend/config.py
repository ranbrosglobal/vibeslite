"""Vibes Lite configuration loading.

A single, small module that every engine imports so configuration is never
duplicated and crop-health thresholds are never hard-coded across the app.

Precedence: environment variables > config.yaml > built-in defaults.
"""
from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any, Dict

import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_CONFIG: Dict[str, Any] = {
    "project": {"name": "Vibes Lite", "version": "0.1.0"},
    "paths": {"raw_data": "data/raw", "processed_data": "data/processed", "outputs": "outputs"},
    "analysis": {
        "default_index": "NDVI",
        "max_analysis_pixels": 4_000_000,
        "fallback_bands": {"blue": 1, "green": 2, "red": 3, "nir": 4},
    },
    "crop_health": {
        "thresholds": {"very_low": 0.20, "low": 0.40, "moderate": 0.60, "healthy": 0.80},
        "min_patch_area_ha": 0.05,
    },
    "opencv": {"enabled": True, "denoise_h": 7, "gaussian_kernel": 5, "canny_low": 50, "canny_high": 150},
    "visualization": {"enabled": True, "dpi": 130, "figure_size": [8.5, 7.0]},
    "timeseries": {"min_observations": 2},
    "api": {"host": "0.0.0.0", "port": 8000, "cors_origins": "*"},
    # OpenStreetMap services. All three providers are reached server-side, so a
    # deployment can point them at its own instances (or switch them off) and
    # the browser never talks to a third party directly.
    "osm": {
        "enabled": True,
        "nominatim_url": "https://nominatim.openstreetmap.org",
        "overpass_url": "https://overpass-api.de/api/interpreter",
        "user_agent": "VibesLite/0.1 (agriculture field intelligence)",
        "contact": "",
        "timeout_seconds": 10,
        # Nominatim's usage policy allows at most one request per second per
        # application. Requests are spaced accordingly instead of being sent in
        # parallel and hoping for the best.
        "min_interval_seconds": 1.1,
        "cache_seconds": 900,
        "max_results": 8,
        "max_radius_m": 5000,
        "max_features": 400,
    },
    # Real satellite imagery. Scenes are found through a STAC catalogue and the
    # actual band files are read straight off the public COG hosting with GDAL's
    # HTTP range reader, so a deployment can point these at its own mirrors (or
    # switch the whole provider off) without touching the browser.
    "satellite": {
        "enabled": True,
        "stac_url": "https://earth-search.aws.element84.com/v1/search",
        "item_url": "https://earth-search.aws.element84.com/v1/collections/{collection}/items/{item_id}",
        "user_agent": "VibesLite/0.1 (agriculture field intelligence)",
        "contact": "",
        "timeout_seconds": 60,
        "cache_seconds": 900,
        # Only these hosts may be read for pixels. The catalogues fetched above
        # are trusted to name bands, but not to redirect a read anywhere else.
        "asset_hosts": ["sentinel-cogs.s3.us-west-2.amazonaws.com", "sentinel-cogs.s3.amazonaws.com"],
        "default_collection": "sentinel-2-l2a",
        "max_radius_m": 5000,
        "max_scenes": 20,
        "max_cloud_cover": 60,
        "max_pixels": 2_000_000,
        "window_days": 120,
    },
    # Real weather for any date. Two keyless public services, both reached
    # server-side: a reanalysis archive (ERA5 / ERA5-Land through Open-Meteo,
    # 1940 -> today) is the "any date" source, and NASA POWER is an independent
    # second opinion on the same days so a number can be challenged rather than
    # merely trusted. Nothing here needs an API key.
    "weather": {
        "enabled": True,
        "forecast_url": "https://api.open-meteo.com/v1/forecast",
        "archive_url": "https://archive-api.open-meteo.com/v1/archive",
        "power_url": "https://power.larc.nasa.gov/api/temporal/daily/point",
        "user_agent": "VibesLite/0.1 (agriculture field intelligence)",
        "contact": "",
        "timeout_seconds": 20,
        "cache_seconds": 900,
        # The archive host answers a share of requests with an nginx 502 and can
        # stall past the timeout (measured: 2 of 4 attempts failed within one
        # minute). A transient failure is retried with backoff, and a window the
        # archive still cannot serve falls back to NASA POWER rather than
        # failing the request.
        "retry_attempts": 2,
        "retry_delay_seconds": 1.5,
        # One request may span at most this many days; the archive holds 1940+.
        "max_days": 3660,
        # The forecast endpoint supplements the most recent days, because a
        # reanalysis archive publishes them late. The provider caps this at 92.
        "recent_days": 14,
        # NASA POWER is a daily product with a much shorter useful span.
        "power_max_days": 366,
    },
    "security": {
        "allowed_raster_ext": [".tif", ".tiff", ".vrt", ".img"],
        "allowed_vector_ext": [".geojson", ".json"],
        "allowed_image_ext": [".png", ".jpg", ".jpeg", ".tif", ".tiff"],
        "allowed_table_ext": [".csv"],
        "max_upload_mb": 200,
    },
}

# Environment variable -> dotted config path overrides (all optional).
_ENV_OVERRIDES = {
    "VIBES_PROJECT_NAME": "project.name",
    "VIBES_RAW_DATA_DIR": "paths.raw_data",
    "VIBES_PROCESSED_DATA_DIR": "paths.processed_data",
    "VIBES_OUTPUTS_DIR": "paths.outputs",
    "VIBES_MAX_UPLOAD_MB": "security.max_upload_mb",
    "VIBES_CORS_ORIGINS": "api.cors_origins",
    "VIBES_HOST": "api.host",
    "VIBES_PORT": "api.port",
    "VIBES_OSM_ENABLED": "osm.enabled",
    "VIBES_NOMINATIM_URL": "osm.nominatim_url",
    "VIBES_OVERPASS_URL": "osm.overpass_url",
    "VIBES_OSM_USER_AGENT": "osm.user_agent",
    "VIBES_OSM_CONTACT": "osm.contact",
    "VIBES_OSM_MAX_RADIUS_M": "osm.max_radius_m",
    "VIBES_SATELLITE_ENABLED": "satellite.enabled",
    "VIBES_STAC_URL": "satellite.stac_url",
    "VIBES_SATELLITE_USER_AGENT": "satellite.user_agent",
    "VIBES_SATELLITE_CONTACT": "satellite.contact",
    "VIBES_SATELLITE_MAX_RADIUS_M": "satellite.max_radius_m",
    "VIBES_SATELLITE_MAX_PIXELS": "satellite.max_pixels",
    "VIBES_SATELLITE_MAX_CLOUD": "satellite.max_cloud_cover",
    "VIBES_SATELLITE_DEFAULT_COLLECTION": "satellite.default_collection",
    "VIBES_WEATHER_ENABLED": "weather.enabled",
    "VIBES_WEATHER_USER_AGENT": "weather.user_agent",
    "VIBES_WEATHER_CONTACT": "weather.contact",
    "VIBES_WEATHER_FORECAST_URL": "weather.forecast_url",
    "VIBES_WEATHER_ARCHIVE_URL": "weather.archive_url",
    "VIBES_WEATHER_POWER_URL": "weather.power_url",
}

_cache: Dict[str, Any] | None = None


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively merge ``override`` into a copy of ``base``."""
    merged = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _coerce(value: str) -> Any:
    """Coerce an environment string into an int/float/list when sensible."""
    stripped = value.strip()
    if stripped.lower() in {"true", "false"}:
        return stripped.lower() == "true"
    if stripped.startswith("[") or stripped.startswith("{"):
        try:
            return yaml.safe_load(stripped)
        except yaml.YAMLError:
            return stripped
    try:
        return int(stripped)
    except ValueError:
        pass
    try:
        return float(stripped)
    except ValueError:
        pass
    return stripped


def _apply_env(cfg: Dict[str, Any]) -> Dict[str, Any]:
    for env_name, dotted in _ENV_OVERRIDES.items():
        raw = os.getenv(env_name)
        if raw is None or raw == "":
            continue
        section, _, leaf = dotted.partition(".")
        cfg.setdefault(section, {})[leaf] = _coerce(raw)
    return cfg


def load_config(path: str | os.PathLike[str] | None = None) -> Dict[str, Any]:
    """Read ``config.yaml`` merged over defaults, then apply env overrides."""
    cfg_path = Path(path or os.getenv("VIBES_CONFIG") or PROJECT_ROOT / "config.yaml")
    if not cfg_path.is_absolute():
        cfg_path = PROJECT_ROOT / cfg_path
    file_cfg: Dict[str, Any] = {}
    if cfg_path.exists():
        with cfg_path.open("r", encoding="utf-8") as handle:
            file_cfg = yaml.safe_load(handle) or {}
    return _apply_env(_deep_merge(DEFAULT_CONFIG, file_cfg))


def get_config() -> Dict[str, Any]:
    """Return the process-wide configuration (loaded once, then cached)."""
    global _cache
    if _cache is None:
        _cache = load_config()
    return _cache


def reload_config() -> Dict[str, Any]:
    """Force a re-read of the configuration (used by tests and tooling)."""
    global _cache
    _cache = None
    return get_config()


def _resolve(raw: str | os.PathLike[str]) -> Path:
    candidate = Path(raw)
    return candidate if candidate.is_absolute() else (PROJECT_ROOT / candidate)


def project_paths() -> Dict[str, Path]:
    """Absolute paths for raw data, processed data and outputs."""
    cfg = get_config()
    paths = cfg.get("paths", {})
    return {
        "root": PROJECT_ROOT,
        "raw_data": _resolve(paths.get("raw_data", DEFAULT_CONFIG["paths"]["raw_data"])),
        "processed_data": _resolve(paths.get("processed_data", DEFAULT_CONFIG["paths"]["processed_data"])),
        "outputs": _resolve(paths.get("outputs", DEFAULT_CONFIG["paths"]["outputs"])),
    }


def ensure_directories() -> Dict[str, Path]:
    """Create the storage directories if they do not exist yet."""
    paths = project_paths()
    for key in ("raw_data", "processed_data", "outputs"):
        paths[key].mkdir(parents=True, exist_ok=True)
    return paths


def security_config() -> Dict[str, Any]:
    cfg = get_config().get("security", {})
    return {**DEFAULT_CONFIG["security"], **cfg}


def osm_config() -> Dict[str, Any]:
    """OpenStreetMap provider settings (URLs, policy limits, cache windows)."""
    cfg = get_config().get("osm", {})
    merged = {**DEFAULT_CONFIG["osm"], **cfg}
    merged["enabled"] = bool(merged["enabled"])
    merged["timeout_seconds"] = float(merged["timeout_seconds"])
    merged["min_interval_seconds"] = max(0.0, float(merged["min_interval_seconds"]))
    merged["cache_seconds"] = max(0.0, float(merged["cache_seconds"]))
    merged["max_results"] = max(1, int(merged["max_results"]))
    merged["max_radius_m"] = max(100, int(merged["max_radius_m"]))
    merged["max_features"] = max(1, int(merged["max_features"]))
    return merged


def satellite_config() -> Dict[str, Any]:
    """Real-satellite provider settings (catalogue URLs, read limits, caching)."""
    cfg = get_config().get("satellite", {})
    merged = {**DEFAULT_CONFIG["satellite"], **cfg}
    merged["enabled"] = bool(merged["enabled"])
    merged["timeout_seconds"] = max(5.0, float(merged["timeout_seconds"]))
    merged["cache_seconds"] = max(0.0, float(merged["cache_seconds"]))
    merged["max_radius_m"] = max(100, int(merged["max_radius_m"]))
    merged["max_scenes"] = max(1, int(merged["max_scenes"]))
    merged["max_cloud_cover"] = min(100.0, max(0.0, float(merged["max_cloud_cover"])))
    merged["max_pixels"] = max(10_000, int(merged["max_pixels"]))
    merged["window_days"] = max(1, min(365, int(merged["window_days"])))
    merged["asset_hosts"] = [str(host).strip().lower() for host in (merged.get("asset_hosts") or []) if str(host).strip()]
    return merged


def weather_config() -> Dict[str, Any]:
    """Real-weather provider settings (endpoints, span limits, caching)."""
    cfg = get_config().get("weather", {})
    merged = {**DEFAULT_CONFIG["weather"], **cfg}
    merged["enabled"] = bool(merged["enabled"])
    merged["timeout_seconds"] = max(5.0, float(merged["timeout_seconds"]))
    merged["cache_seconds"] = max(0.0, float(merged["cache_seconds"]))
    merged["retry_attempts"] = max(1, min(5, int(merged["retry_attempts"])))
    merged["retry_delay_seconds"] = max(0.0, min(30.0, float(merged["retry_delay_seconds"])))
    merged["max_days"] = max(1, int(merged["max_days"]))
    # The provider's own ceiling for how far back the forecast endpoint may be
    # asked to reach; a larger value is clamped rather than sent and rejected.
    merged["recent_days"] = max(0, min(92, int(merged["recent_days"])))
    merged["power_max_days"] = max(1, int(merged["power_max_days"]))
    return merged


def max_analysis_pixels() -> int:
    return int(get_config().get("analysis", {}).get("max_analysis_pixels", 4_000_000))


def fallback_band_map() -> Dict[str, int]:
    return dict(get_config().get("analysis", {}).get("fallback_bands", DEFAULT_CONFIG["analysis"]["fallback_bands"]))


def health_thresholds() -> Dict[str, float]:
    """Configurable crop-health breakpoints: very_low < low < moderate < healthy."""
    thresholds = get_config().get("crop_health", {}).get("thresholds", {})
    merged = {**DEFAULT_CONFIG["crop_health"]["thresholds"], **thresholds}
    return {key: float(merged[key]) for key in ("very_low", "low", "moderate", "healthy")}


def project_info() -> Dict[str, Any]:
    """Small, filesystem-internal-free project descriptor for the API."""
    cfg = get_config()
    return {
        "name": cfg.get("project", {}).get("name", "Vibes Lite"),
        "version": cfg.get("project", {}).get("version", "0.1.0"),
        "description": cfg.get("project", {}).get("description", ""),
        "default_index": cfg.get("analysis", {}).get("default_index", "NDVI"),
        "crop_health_thresholds": health_thresholds(),
        "opencv_enabled": bool(cfg.get("opencv", {}).get("enabled", True)),
        "visualization_enabled": bool(cfg.get("visualization", {}).get("enabled", True)),
        "inspiration": "Independent implementation inspired by Microsoft FarmVibes.AI concepts (no shared code or runtime dependency).",
    }
