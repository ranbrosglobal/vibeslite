"""Data ingestion and validation for Vibes Lite.

Supported inputs
----------------
* GeoTIFF / raster imagery (single or multi band, RGB or multispectral)
* GeoJSON / field boundaries (AOI)
* CSV tabular datasets (field-level NDVI history, weather later on)

Everything here is read-only with respect to source files: engines never mutate
raw data, they work on arrays handed to them by these loaders.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Sequence

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError
from rasterio.transform import from_origin

from config import ensure_directories, project_paths, security_config

# --------------------------------------------------------------------------- #
# errors
# --------------------------------------------------------------------------- #
class DataError(RuntimeError):
    """Base class for user-correctable data problems (maps to HTTP 400)."""

    status_code = 400


class NotFoundError(DataError):
    """Requested dataset / AOI / file does not exist (maps to HTTP 404)."""

    status_code = 404


class RasterError(DataError):
    """Raster could not be opened or is unusable."""


class AOIError(DataError):
    """Field boundary / AOI is missing, invalid or unusable."""


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _kind_of(path: Path) -> str:
    ext = path.suffix.lower()
    security = security_config()
    if ext in security["allowed_raster_ext"]:
        return "raster"
    if ext in security["allowed_vector_ext"]:
        return "vector"
    if ext in security["allowed_table_ext"]:
        return "table"
    if ext in security["allowed_image_ext"]:
        return "image"
    return "unknown"


def kind_for_filename(filename: str) -> str:
    """Public type detection for an upload name ('raster'|'vector'|'table'|'image'|'unknown')."""
    try:
        return _kind_of(Path(str(filename).replace("\\", "/").split("/")[-1]))
    except Exception:  # pragma: no cover - defensive
        return "unknown"


def allowed_extensions(kind: str) -> List[str]:
    security = security_config()
    return {
        "raster": security["allowed_raster_ext"],
        "vector": security["allowed_vector_ext"],
        "table": security["allowed_table_ext"],
        "image": security["allowed_image_ext"],
    }.get(kind, [])


def safe_filename(filename: str, kind: str | None = None) -> str:
    """Reduce an untrusted upload name to a safe basename with a known extension."""
    raw = str(filename or "").replace("\\", "/")
    base = raw.split("/")[-1].strip()
    if not base or base in {".", ".."}:
        raise DataError("Invalid file name")
    stem, dot, ext = base.rpartition(".")
    if not dot:
        raise DataError("File name requires an extension")
    ext = "." + re.sub(r"[^A-Za-z0-9]", "", ext).lower()
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-._") or "upload"
    stem = stem.replace("..", "-")[:80]
    name = f"{stem}{ext}"
    if kind:
        if ext not in allowed_extensions(kind):
            raise DataError(
                f"Unsupported {kind} extension '{ext}'. Allowed: {', '.join(allowed_extensions(kind))}"
            )
    return name


def unique_path(directory: Path, filename: str) -> Path:
    """Return a non-colliding path inside ``directory``."""
    directory.mkdir(parents=True, exist_ok=True)
    candidate = directory / filename
    if not candidate.exists():
        return candidate
    stem, ext = candidate.stem, candidate.suffix
    for index in range(1, 1000):
        candidate = directory / f"{stem}-{index}{ext}"
        if not candidate.exists():
            return candidate
    raise DataError("Could not allocate a unique file name")


def resolve_dataset(name: str) -> Path:
    """Resolve a dataset name inside ``data/raw`` (no path traversal)."""
    if not name:
        raise DataError("A dataset name is required")
    clean = str(name).replace("\\", "/").split("/")[-1]
    if clean in {"", ".", ".."}:
        raise DataError("Invalid dataset name")
    raw_dir = project_paths()["raw_data"]
    path = (raw_dir / clean).resolve()
    if raw_dir.resolve() != path.parent:
        raise DataError("Invalid dataset name")
    if not path.exists():
        raise NotFoundError(f"Dataset '{clean}' not found in the raw data directory")
    return path


def resolve_optional_dataset(name: str | None) -> Path | None:
    return resolve_dataset(name) if name else None


# --------------------------------------------------------------------------- #
# raster metadata / validation
# --------------------------------------------------------------------------- #
def _crs_summary(crs: Any) -> Dict[str, Any]:
    if crs is None:
        return {"defined": False, "epsg": None, "name": "undefined", "is_projected": False, "unit": None}
    epsg = None
    try:
        epsg = crs.to_epsg()
    except Exception:  # pragma: no cover - defensive
        epsg = None
    return {
        "defined": True,
        "epsg": epsg,
        "name": crs.name if hasattr(crs, "name") else str(crs),
        "is_projected": bool(getattr(crs, "is_projected", False)),
        "unit": (crs.linear_units if getattr(crs, "is_projected", False) else getattr(crs, "angular_units", None)),
    }


def get_raster_metadata(path: str | Path) -> Dict[str, Any]:
    """Read-only metadata summary for a raster file."""
    file_path = Path(path)
    if not file_path.exists():
        raise NotFoundError(f"Raster '{file_path.name}' not found")
    try:
        with rasterio.open(file_path) as dataset:
            transform = dataset.transform
            res_x = abs(transform.a) or None
            res_y = abs(transform.e) or None
            crs_info = _crs_summary(dataset.crs)
            bounds = dataset.bounds
            descriptions = [d or "" for d in (dataset.descriptions or [])]
            tags = dict(dataset.tags() or {})
            band_tags = {}
            for band in range(1, dataset.count + 1):
                try:
                    band_tags[str(band)] = dict(dataset.tags(band) or {})
                except Exception:  # pragma: no cover - defensive
                    band_tags[str(band)] = {}
            bounds_lonlat = _bounds_lonlat(bounds, dataset.crs)
            area_ha = None
            if crs_info["is_projected"]:
                area_ha = float((bounds.right - bounds.left) * (bounds.top - bounds.bottom) / 10_000.0)
            return {
                "name": file_path.name,
                "driver": dataset.driver,
                "width": dataset.width,
                "height": dataset.height,
                "band_count": dataset.count,
                "dtypes": [str(dt) for dt in (dataset.dtypes or [])],
                "band_descriptions": descriptions,
                "band_tags": band_tags,
                "nodata": None if dataset.nodata is None else float(dataset.nodata),
                "crs": crs_info,
                "bounds": {
                    "left": float(bounds.left),
                    "bottom": float(bounds.bottom),
                    "right": float(bounds.right),
                    "top": float(bounds.top),
                },
                "bounds_lonlat": bounds_lonlat,
                "resolution": {"x": res_x, "y": res_y, "unit": crs_info["unit"]},
                "pixel_count": int(dataset.width * dataset.height),
                "area_ha": area_ha,
                "tags": tags,
                "is_georeferenced": bool(dataset.crs is not None and transform is not None and transform != rasterio.Affine.identity()),
                "synthetic": str(tags.get("SYNTHETIC", "")).lower() in {"true", "1", "yes"},
                "file_size_mb": round(file_path.stat().st_size / (1024 * 1024), 3),
            }
    except RasterioIOError as exc:
        raise RasterError(f"Could not open raster '{file_path.name}': {exc}") from exc


def _bounds_lonlat(bounds: Any, crs: Any) -> List[float] | None:
    """Raster bounds as [west, south, east, north] in EPSG:4326 (if possible)."""
    if crs is None:
        return None
    try:
        from rasterio.warp import transform_bounds

        west, south, east, north = transform_bounds(crs, "EPSG:4326", *bounds, densify_pts=21)
        return [float(west), float(south), float(east), float(north)]
    except Exception:  # pragma: no cover - defensive
        return None


def validate_raster(path: str | Path, max_upload_mb: int | None = None) -> Dict[str, Any]:
    """Validate a raster and return metadata plus non-fatal warnings."""
    file_path = Path(path)
    warnings: List[str] = []
    if not file_path.exists():
        raise NotFoundError(f"Raster '{file_path.name}' not found")
    if not file_path.is_file():
        raise RasterError("Raster path is not a file")
    if file_path.suffix.lower() not in allowed_extensions("raster"):
        raise RasterError(
            f"Unsupported raster extension '{file_path.suffix}'. Allowed: {', '.join(allowed_extensions('raster'))}"
        )
    limit_mb = max_upload_mb or int(security_config()["max_upload_mb"])
    size_mb = file_path.stat().st_size / (1024 * 1024)
    if size_mb > limit_mb:
        raise RasterError(f"Raster is {size_mb:.1f} MB which exceeds the {limit_mb} MB limit")

    metadata = get_raster_metadata(file_path)
    if metadata["band_count"] < 1:
        raise RasterError("Raster contains no bands")
    if metadata["width"] < 2 or metadata["height"] < 2:
        raise RasterError("Raster is too small to analyse (needs at least 2x2 pixels)")
    if not metadata["crs"]["defined"]:
        warnings.append("Raster has no CRS; georeferenced clipping and area estimates will be unavailable.")
    if not metadata["is_georeferenced"] and metadata["crs"]["defined"]:
        warnings.append("Raster transform looks like the identity transform; pixel/ground alignment may be wrong.")
    if metadata["nodata"] is None:
        warnings.append("Raster declares no nodata value; zero-valued pixels are treated as nodata where sensible.")
    return {"metadata": metadata, "warnings": warnings}


# --------------------------------------------------------------------------- #
# raster loading
# --------------------------------------------------------------------------- #
def load_raster(
    path: str | Path,
    bands: Sequence[int] | None = None,
    window: Any = None,
    out_shape: tuple[int, int] | None = None,
    apply_scale: bool = True,
) -> Dict[str, Any]:
    """Load raster bands into memory.

    ``bands`` are 1-based band numbers. When ``out_shape`` is given, rasterio
    reads a decimated view (using overviews when available) instead of the full
    resolution array, which keeps memory bounded on large scenes.
    """
    file_path = Path(path)
    if not file_path.exists():
        raise NotFoundError(f"Raster '{file_path.name}' not found")
    try:
        with rasterio.open(file_path) as dataset:
            band_list = list(bands) if bands else list(range(1, dataset.count + 1))
            for band in band_list:
                if band < 1 or band > dataset.count:
                    raise RasterError(f"Band {band} requested but raster has {dataset.count} band(s)")
            array = dataset.read(band_list, window=window, out_shape=out_shape, masked=False)
            scale = 1.0
            offset = 0.0
            if apply_scale:
                scales = [dataset.scales[b - 1] for b in band_list]
                offsets = [dataset.offsets[b - 1] for b in band_list]
                # rasterio reports (1.0, 0.0) when a file carries no scaling.
                if any(s not in (None, 1.0) for s in scales) or any(o not in (None, 0.0) for o in offsets):
                    scale = float(scales[0] or 1.0)
                    offset = float(offsets[0] or 0.0)
                    array = array.astype("float32") * scale + offset
            transform = dataset.window_transform(window) if window is not None else dataset.transform
            nodata = None if dataset.nodata is None else float(dataset.nodata)
            descriptions = [dataset.descriptions[b - 1] or "" for b in band_list]
            tags = dict(dataset.tags() or {})
            return {
                "array": np.asarray(array),
                "bands": band_list,
                "count": len(band_list),
                "descriptions": descriptions,
                "transform": transform,
                "crs": dataset.crs,
                "nodata": nodata,
                "scale_factor": scale,
                "offset": offset,
                "shape": (array.shape[-2], array.shape[-1]),
                "dtype": str(array.dtype),
                "driver": dataset.driver,
                "tags": tags,
                "synthetic": str(tags.get("SYNTHETIC", "")).lower() in {"true", "1", "yes"},
                "name": file_path.name,
                "window": None if window is None else tuple(window),
                "applied_scaling": bool(apply_scale and (scale != 1.0 or offset != 0.0)),
            }
    except RasterioIOError as exc:
        raise RasterError(f"Could not read raster '{file_path.name}': {exc}") from exc


def load_single_band(path: str | Path, band: int = 1) -> Dict[str, Any]:
    """Convenience wrapper returning a 2D array for one band."""
    loaded = load_raster(path, bands=[band])
    loaded["array"] = loaded["array"][0]
    return loaded


def raster_band_summary(path: str | Path, max_samples: int = 4096) -> List[Dict[str, Any]]:
    """Per-band statistics from a sparse sample (cheap, for API listings)."""
    with rasterio.open(path) as dataset:
        summaries = []
        step = max(1, int(np.sqrt((dataset.width * dataset.height) / max_samples)))
        for band in range(1, dataset.count + 1):
            sample = dataset.read(band, out_shape=(
                max(1, dataset.height // step),
                max(1, dataset.width // step),
            )).astype("float32")
            nodata = dataset.nodata
            if nodata is not None:
                sample = np.where(sample == nodata, np.nan, sample)
            valid = sample[np.isfinite(sample)]
            summaries.append(
                {
                    "band": band,
                    "description": (dataset.descriptions or [""] * dataset.count)[band - 1] or "",
                    "min": float(np.min(valid)) if valid.size else None,
                    "max": float(np.max(valid)) if valid.size else None,
                    "mean": float(np.mean(valid)) if valid.size else None,
                    "sampled_pixels": int(valid.size),
                }
            )
        return summaries


# --------------------------------------------------------------------------- #
# vector / AOI loading
# --------------------------------------------------------------------------- #
def _as_geodataframe(source: Any):
    import geopandas as gpd
    import pandas as pd
    from shapely.geometry import shape

    if isinstance(source, gpd.GeoDataFrame):
        return source.copy()
    if isinstance(source, Mapping):
        features = source.get("features")
        if features is None and source.get("type") == "Feature":
            features = [source]
        if features is None and source.get("type") in {"Polygon", "MultiPolygon"}:
            return gpd.GeoDataFrame({"name": ["AOI"]}, geometry=[shape(source)], crs="EPSG:4326")
        if features is None:
            raise AOIError("GeoJSON must contain a FeatureCollection, Feature or geometry")
        return gpd.GeoDataFrame.from_features(features, crs=source.get("crs") or None)
    if isinstance(source, str):
        text = source.strip()
        if text.startswith("{") or text.startswith("["):
            return _as_geodataframe(json.loads(text))
        return load_aoi(text)
    if isinstance(source, pd.DataFrame):
        return gpd.GeoDataFrame(source)
    raise AOIError(f"Unsupported AOI input type: {type(source).__name__}")


def validate_aoi(gdf: Any, *, require_polygon: bool = True) -> Dict[str, Any]:
    """Validate and clean an AOI GeoDataFrame; returns it plus warnings."""
    import geopandas as gpd
    from shapely.validation import make_valid

    if gdf is None or len(gdf) == 0:
        raise AOIError("AOI contains no features")
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326", allow_override=True)
    warnings: List[str] = []

    kept_indices: List[int] = []
    kept_geometries: List[Any] = []
    for position, geom in enumerate(gdf.geometry):
        if geom is None or geom.is_empty:
            warnings.append("Dropped an empty geometry from the AOI.")
            continue
        if not geom.is_valid:
            geom = make_valid(geom)
            warnings.append("Repaired an invalid geometry (self-intersection).")
        kept_indices.append(position)
        kept_geometries.append(geom)
    cleaned = gdf.iloc[kept_indices].copy()
    cleaned = cleaned.set_geometry(gpd.GeoSeries(kept_geometries, index=cleaned.index, crs=gdf.crs))
    cleaned = cleaned.reset_index(drop=True)
    if len(cleaned) == 0:
        raise AOIError("AOI has no valid geometries")

    if require_polygon:
        allowed = {"Polygon", "MultiPolygon"}
        types = {str(value) for value in cleaned.geometry.geom_type.unique() if isinstance(value, str)}
        if not types <= allowed:
            raise AOIError(f"AOI must contain polygonal features, received: {', '.join(sorted(types))}")
    if not cleaned.geometry.is_valid.all():
        raise AOIError("AOI still contains invalid geometries after repair")

    area_ha = None
    try:
        area_ha = float(geometry_area_hectares(cleaned).sum())
    except Exception as exc:  # pragma: no cover - defensive
        warnings.append(f"Could not compute AOI area: {exc}")

    if "name" not in cleaned.columns:
        cleaned["name"] = [f"field_{i + 1}" for i in range(len(cleaned))]
    return {
        "gdf": cleaned,
        "feature_count": int(len(cleaned)),
        "area_ha": area_ha,
        "crs": str(cleaned.crs),
        "warnings": warnings,
    }


def load_aoi(path: str | Path, require_polygon: bool = True) -> Dict[str, Any]:
    """Load a field boundary file (GeoJSON) and validate its geometry."""
    import geopandas as gpd

    file_path = Path(path)
    if not file_path.exists():
        raise NotFoundError(f"AOI '{file_path.name}' not found")
    if file_path.suffix.lower() not in allowed_extensions("vector"):
        raise AOIError(
            f"Unsupported AOI extension '{file_path.suffix}'. Allowed: {', '.join(allowed_extensions('vector'))}"
        )
    try:
        gdf = gpd.read_file(file_path)
    except Exception as exc:
        raise AOIError(f"Could not read AOI '{file_path.name}': {exc}") from exc
    result = validate_aoi(gdf, require_polygon=require_polygon)
    result["name"] = file_path.name
    result["geojson"] = aoi_to_geojson(result["gdf"])
    return result


def load_geojson(source: Any, require_polygon: bool = True) -> Dict[str, Any]:
    """Load / validate an AOI from a GeoJSON dict, JSON string or file path."""
    if isinstance(source, str) and not source.strip().startswith("{"):
        return load_aoi(source, require_polygon=require_polygon)
    gdf = _as_geodataframe(source)
    result = validate_aoi(gdf, require_polygon=require_polygon)
    result["geojson"] = aoi_to_geojson(result["gdf"])
    return result


def aoi_to_geojson(gdf: Any) -> Dict[str, Any]:
    """Serialise an AOI GeoDataFrame to a WGS84 FeatureCollection."""
    working = gdf
    if working.crs is not None and str(working.crs).upper() != "EPSG:4326":
        working = working.to_crs("EPSG:4326")
    return json.loads(working.to_json())


def geometry_area_hectares(gdf: Any) -> Any:
    """Per-feature area in hectares, using a suitable equal-area projection.

    Geographic input is projected first: the local UTM zone for field-scale AOIs
    (accurate to well under a percent at this scale) or the global equal-area
    projection EPSG:6933 when the AOI spans several UTM zones.
    """
    from pyproj import CRS

    if gdf.crs is None:
        raise AOIError("Cannot compute area for an AOI without a CRS")
    crs = CRS.from_user_input(gdf.crs)
    if crs.is_geographic:
        lonlat = gdf.to_crs("EPSG:4326")
        min_lon, min_lat, max_lon, max_lat = lonlat.total_bounds
        if (max_lon - min_lon) > 3.0:
            target = CRS.from_epsg(6933)  # World Equal Area
        else:
            zone = int(math.floor(((min_lon + max_lon) / 2 + 180) / 6) % 60) + 1
            target = CRS.from_epsg((32600 if ((min_lat + max_lat) / 2) >= 0 else 32700) + zone)
        projected = gdf.to_crs(target)
    else:
        projected = gdf
    return projected.geometry.area / 10_000.0


def save_aoi(gdf: Any, name: str) -> Dict[str, Any]:
    """Persist a validated AOI into ``data/raw`` as GeoJSON.

    ``name`` may be given with or without a ``.geojson`` extension.
    """
    paths = ensure_directories()
    candidate = str(name or "uploaded_aoi").strip()
    if Path(candidate).suffix.lower() not in allowed_extensions("vector"):
        candidate = f"{candidate}.geojson"
    filename = safe_filename(candidate, kind="vector")
    target = unique_path(paths["raw_data"], filename)
    serialised = aoi_to_geojson(gdf)
    with target.open("w", encoding="utf-8") as handle:
        json.dump(serialised, handle, indent=2)
    return {"name": target.name, "path": target, "geojson": serialised, "bytes": target.stat().st_size}


# --------------------------------------------------------------------------- #
# CSV
# --------------------------------------------------------------------------- #
def load_csv(path: str | Path):
    """Load a CSV dataset (field statistics, weather, observation history)."""
    import pandas as pd

    file_path = Path(path)
    if not file_path.exists():
        raise NotFoundError(f"CSV '{file_path.name}' not found")
    try:
        return pd.read_csv(file_path)
    except Exception as exc:
        raise DataError(f"Could not read CSV '{file_path.name}': {exc}") from exc


def load_dataset(path: str | Path) -> Dict[str, Any]:
    """Auto-detect the dataset type and return a uniform descriptor."""
    file_path = Path(path)
    kind = _kind_of(file_path)
    if kind == "raster":
        payload = validate_raster(file_path)
        return {"type": "raster", "name": file_path.name, **payload}
    if kind == "vector":
        aoi = load_aoi(file_path)
        return {
            "type": "vector",
            "name": file_path.name,
            "feature_count": aoi["feature_count"],
            "area_ha": aoi["area_ha"],
            "crs": aoi["crs"],
            "warnings": aoi["warnings"],
            "geojson": aoi["geojson"],
        }
    if kind == "table":
        frame = load_csv(file_path)
        return {
            "type": "table",
            "name": file_path.name,
            "rows": int(len(frame)),
            "columns": [str(c) for c in frame.columns],
        }
    if kind == "image":
        return {"type": "image", "name": file_path.name, "file_size_mb": round(file_path.stat().st_size / 1e6, 3)}
    raise DataError(f"Unsupported dataset type for '{file_path.name}'")


def list_datasets() -> List[Dict[str, Any]]:
    """List datasets available in ``data/raw`` (metadata only, no payloads)."""
    raw_dir = project_paths()["raw_data"]
    if not raw_dir.exists():
        return []
    entries: List[Dict[str, Any]] = []
    for path in sorted(raw_dir.iterdir()):
        if path.name.startswith(".") or not path.is_file():
            continue
        if path.suffix.lower() == ".json" and path.name.endswith("result.json"):
            continue
        kind = _kind_of(path)
        entry: Dict[str, Any] = {
            "name": path.name,
            "type": kind,
            "size_mb": round(path.stat().st_size / 1e6, 3),
            "modified": int(path.stat().st_mtime),
        }
        try:
            if kind == "raster":
                meta = get_raster_metadata(path)
                entry.update(
                    {
                        "band_count": meta["band_count"],
                        "band_descriptions": meta["band_descriptions"],
                        "crs": meta["crs"]["name"],
                        "epsg": meta["crs"]["epsg"],
                        "shape": [meta["height"], meta["width"]],
                        "resolution": meta["resolution"],
                        "bounds_lonlat": meta["bounds_lonlat"],
                        "area_ha": meta["area_ha"],
                        "synthetic": meta["synthetic"],
                    }
                )
            elif kind == "vector":
                aoi = load_aoi(path)
                entry.update(
                    {
                        "feature_count": aoi["feature_count"],
                        "area_ha": aoi["area_ha"],
                        "crs": aoi["crs"],
                    }
                )
        except DataError as exc:
            entry["error"] = str(exc)
        entries.append(entry)
    return entries


# --------------------------------------------------------------------------- #
# uploads
# --------------------------------------------------------------------------- #
def save_upload(filename: str, content: bytes, kind: str = "raster") -> Dict[str, Any]:
    """Validate and store an uploaded file in ``data/raw``."""
    security = security_config()
    limit_bytes = int(security["max_upload_mb"]) * 1024 * 1024
    if len(content) == 0:
        raise DataError("Uploaded file is empty")
    if len(content) > limit_bytes:
        raise DataError(f"Upload exceeds the {security['max_upload_mb']} MB limit")
    name = safe_filename(filename, kind=kind)
    paths = ensure_directories()
    target = unique_path(paths["raw_data"], name)
    target.write_bytes(content)

    detail: Dict[str, Any] = {"name": target.name, "type": kind, "bytes": len(content)}
    try:
        if kind in {"raster", "image"} and target.suffix.lower() in security["allowed_raster_ext"]:
            detail["metadata"] = validate_raster(target)["metadata"]
        elif kind == "vector":
            detail["aoi"] = {k: v for k, v in load_aoi(target).items() if k != "gdf"}
        elif kind == "table":
            frame = load_csv(target)
            detail["rows"] = int(len(frame))
            detail["columns"] = [str(c) for c in frame.columns]
    except DataError:
        # Never leave a file that the platform cannot use.
        target.unlink(missing_ok=True)
        raise
    return detail


# --------------------------------------------------------------------------- #
# processed rasters
# --------------------------------------------------------------------------- #
def save_processed_raster(
    array: np.ndarray,
    transform: Any,
    crs: Any,
    name: str,
    nodata: float = -9999.0,
    dtype: str = "float32",
) -> Path:
    """Write an analysis product (e.g. the NDVI raster) to ``data/processed``.

    Keeping products out of the API response keeps responses small while the
    GeoTIFF stays usable in QGIS / downstream models.
    """
    paths = ensure_directories()
    filename = safe_filename(name, kind="raster")
    target = unique_path(paths["processed_data"], filename)
    data = np.asarray(array)
    if data.ndim == 2:
        data = data[np.newaxis, :, :]
    bands, height, width = data.shape
    filled = np.where(np.isfinite(data), data, nodata).astype(dtype)
    with rasterio.open(
        target,
        "w",
        driver="GTiff",
        height=height,
        width=width,
        count=bands,
        dtype=dtype,
        crs=crs,
        transform=transform,
        nodata=nodata,
        compress="deflate",
    ) as dataset:
        dataset.write(filled)
        dataset.update_tags(PRODUCT="vibes-lite", SYNTHETIC="false")
    return target


# --------------------------------------------------------------------------- #
# synthetic sample scene (explicitly labelled, for demos and tests only)
# --------------------------------------------------------------------------- #
SYNTHETIC_NOTE = (
    "Synthetic demonstration scene generated by Vibes Lite. Values are modelled "
    "reflectance, NOT real satellite or drone imagery. Use it to exercise the "
    "pipeline end to end, then replace it with your own GeoTIFF / GeoJSON."
)


def generate_synthetic_scene(
    name: str = "synthetic_fields",
    size: int = 1200,
    pixel_size: float = 10.0,
    seed: int = 20260926,
    overwrite: bool = False,
) -> Dict[str, Any]:
    """Create a small synthetic Sentinel-2-like 4-band scene plus field boundaries.

    The scene contains four adjacent farm plots with a healthy crop, a
    nutrient-stress patch and a bare-soil strip so that NDVI, crop-health zones
    and weak-vegetation detection all have something meaningful to find.

    ``overwrite`` regenerates onto the plain ``name`` files (used by the demo
    endpoint so repeated calls stay idempotent) instead of allocating
    ``name-1``, ``name-2`` copies.
    """

    from shapely.geometry import box, mapping

    paths = ensure_directories()

    def target(filename: str) -> Path:
        """Where a demo artefact should live: canonical name, or a unique copy."""
        if not overwrite:
            return unique_path(paths["raw_data"], filename)
        resolved = paths["raw_data"] / filename
        resolved.unlink(missing_ok=True)
        return resolved

    rng = np.random.default_rng(seed)
    # UTM zone 33N near 41N 12E: a plausible European farmland location.
    origin_x, origin_y = 250_000.0, 4_540_000.0
    transform = from_origin(origin_x, origin_y, pixel_size, pixel_size)
    crs = rasterio.crs.CRS.from_epsg(32633)

    yy, xx = np.mgrid[0:size, 0:size].astype("float32")
    vegetation = 0.62 + 0.18 * np.sin(xx / 90.0) * np.cos(yy / 130.0) + rng.normal(0, 0.045, (size, size))
    # Nutrient-stress patch (lower vegetation index).
    stress = np.exp(-(((xx - size * 0.34) ** 2 + (yy - size * 0.62) ** 2) / (2 * (size * 0.075) ** 2)))
    vegetation -= 0.42 * stress
    # Bare soil / fallow strip across the scene.
    strip = (np.abs(yy - size * 0.24) < size * 0.035).astype("float32")
    vegetation = vegetation * (1 - 0.9 * strip)
    vegetation = np.clip(vegetation, 0.02, 1.0)

    def band(soil: float, canopy: float, gain: float) -> np.ndarray:
        values = soil + (canopy - soil) * vegetation + rng.normal(0, 0.006, (size, size))
        return np.clip(values, 0.001, 1.2)

    blue = band(0.24, 0.035, 1.0)
    green = band(0.26, 0.070, 1.0)
    red = band(0.24, 0.040, 1.0)
    nir = band(0.29, 0.470, 1.0)

    # Sentinel-2 L2A style: uint16 reflectance * 10000 with a nodata border.
    arrays = np.stack([blue, green, red, nir]).astype("float32")
    scaled = np.rint(arrays * 10_000.0).astype("uint16")
    border = int(size * 0.012)
    scaled[:, :border, :] = 0
    scaled[:, -border:, :] = 0
    scaled[:, :, :border] = 0
    scaled[:, :, -border:] = 0

    raster_name = safe_filename(f"{name}.tif", kind="raster")
    raster_path = target(raster_name)
    with rasterio.open(
        raster_path,
        "w",
        driver="GTiff",
        height=size,
        width=size,
        count=4,
        dtype="uint16",
        crs=crs,
        transform=transform,
        nodata=0,
        compress="deflate",
    ) as dataset:
        dataset.write(scaled)
        for index, label in enumerate(["B02", "B03", "B04", "B08"], start=1):
            dataset.set_band_description(index, label)
            dataset.update_tags(index, NAME={"B02": "blue", "B03": "green", "B04": "red", "B08": "nir"}[label])
        dataset.scales = (0.0001, 0.0001, 0.0001, 0.0001)
        dataset.update_tags(
            SYNTHETIC="true",
            NOTE=SYNTHETIC_NOTE,
            SENSOR="synthetic-s2-l2a-like",
            ACQUIRED="2026-07-14",
        )

    # Four plots covering the scene, each with a crop label.
    span = size * pixel_size
    plot_geoms = {
        "North Field": box(origin_x + 0.03 * span, origin_y - 0.48 * span, origin_x + 0.46 * span, origin_y - 0.05 * span),
        "South Field": box(origin_x + 0.05 * span, origin_y - 0.95 * span, origin_x + 0.52 * span, origin_y - 0.53 * span),
        "East Field": box(origin_x + 0.54 * span, origin_y - 0.90 * span, origin_x + 0.96 * span, origin_y - 0.30 * span),
        "Stress Trial Plot": box(origin_x + 0.20 * span, origin_y - 0.78 * span, origin_x + 0.50 * span, origin_y - 0.60 * span),
    }
    from shapely.geometry import shape  # noqa: F401  (kept for symmetry with geopandas usage)

    import geopandas as gpd

    gdf = gpd.GeoDataFrame(
        {
            "name": list(plot_geoms.keys()),
            "crop": ["winter wheat", "maize", "sunflower", "winter wheat"],
            "management": ["conventional", "conventional", "conventional", "nutrient trial"],
        },
        geometry=list(plot_geoms.values()),
        crs=crs,
    )
    geo_name = safe_filename(f"{name}.geojson", kind="vector")
    geo_path = target(geo_name)
    gdf.to_file(geo_path, driver="GeoJSON")

    # A short synthetic NDVI history so the time-series page has something real to plot.
    import pandas as pd

    dates = pd.date_range("2026-04-08", periods=7, freq="14D")
    rows = []
    for field_name, base in (("North Field", 0.38), ("South Field", 0.44), ("East Field", 0.33)):
        for index, date in enumerate(dates):
            value = base + 0.055 * index + rng.normal(0, 0.012)
            rows.append(
                {
                    "date": date.date().isoformat(),
                    "field": field_name,
                    "ndvi_mean": round(float(np.clip(value, 0.0, 0.95)), 4),
                    "cloud_cover_pct": round(float(abs(rng.normal(8, 6))), 1),
                    "source": "synthetic",
                }
            )
    csv_name = safe_filename(f"{name}_ndvi_history.csv", kind="table")
    csv_path = target(csv_name)
    pd.DataFrame(rows).to_csv(csv_path, index=False)

    return {
        "synthetic": True,
        "note": SYNTHETIC_NOTE,
        "raster": {"name": raster_path.name, "band_count": 4, "band_descriptions": ["B02", "B03", "B04", "B08"]},
        "aoi": {"name": geo_path.name, "feature_count": int(len(gdf))},
        "table": {"name": csv_path.name, "rows": len(rows)},
        "paths": {"raster": raster_path, "aoi": geo_path, "table": csv_path},
    }


def dataset_names(kinds: Iterable[str] | None = None) -> List[str]:
    wanted = set(kinds) if kinds else None
    return [entry["name"] for entry in list_datasets() if wanted is None or entry["type"] in wanted]
