"""Preprocessing engine.

Everything in this module is pure: inputs are never modified in place, each
function returns new arrays. That keeps raw data immutable and makes the
pipeline reproducible - the same GeoTIFF always yields the same NDVI.

Responsibilities: nodata handling, band extraction, normalisation, resizing,
clipping to an AOI, uint8 preparation for display and decimation for analysis.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, Mapping, Sequence, Tuple

import numpy as np
import rasterio

from data import DataError, RasterError, load_raster


# --------------------------------------------------------------------------- #
# nodata / validity
# --------------------------------------------------------------------------- #
def build_valid_mask(band: np.ndarray, nodata: float | None = None, nonfinite_is_invalid: bool = True) -> np.ndarray:
    """Boolean mask of usable pixels (True = valid).

    A raster without a declared nodata value still frequently uses 0 as a
    fill value; that case is reported by ``validate_raster`` as a warning and
    handled here only when the caller asks for it explicitly.
    """
    data = np.asarray(band)
    valid = np.ones(data.shape, dtype=bool)
    if nodata is not None:
        valid &= ~np.isclose(data, nodata)
    if nonfinite_is_invalid:
        valid &= np.isfinite(data)
    return valid


def handle_nodata(band: np.ndarray, nodata: float | None = None, zero_is_nodata: bool = False) -> np.ma.MaskedArray:
    """Return a masked array where nodata / non-finite pixels are masked."""
    valid = build_valid_mask(band, nodata)
    if zero_is_nodata:
        valid &= ~np.isclose(np.asarray(band), 0.0)
    return np.ma.masked_array(np.asarray(band, dtype="float32"), mask=~valid)


def combine_valid_masks(*masks: np.ndarray) -> np.ndarray:
    """AND together several boolean validity masks."""
    if not masks:
        raise DataError("At least one mask is required")
    combined = np.ones(np.asarray(masks[0]).shape, dtype=bool)
    for mask in masks:
        combined &= np.asarray(mask, dtype=bool)
    return combined


def mask_to_nan(array: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Float copy of ``array`` with invalid pixels set to NaN."""
    data = np.asarray(array, dtype="float32").copy()
    data[~np.asarray(valid, dtype=bool)] = np.nan
    return data


# --------------------------------------------------------------------------- #
# band extraction
# --------------------------------------------------------------------------- #
def band_stack(
    clipped: Mapping[str, Any],
    band_map: Mapping[str, int],
    mask_outside_aoi: bool = True,
) -> Dict[str, Any]:
    """Map requested physical bands (red, nir, ...) onto a clipped raster stack.

    ``band_map`` values are 1-based band numbers of the *source* raster; the
    clipped stack carries ``clipped['bands']`` so the lookup is exact.
    """
    source_bands: Sequence[int] = list(clipped["bands"])
    array = np.asarray(clipped["array"])
    if array.ndim == 2:
        array = array[np.newaxis, :, :]

    nodata = clipped.get("nodata")
    stack: Dict[str, np.ndarray] = {}
    valid = np.ones(array.shape[1:], dtype=bool)
    aoi_mask = np.asarray(clipped.get("mask")) if clipped.get("mask") is not None else None

    for label, band_number in band_map.items():
        if band_number not in source_bands:
            raise RasterError(f"Band {band_number} for '{label}' was not included in the clip")
        layer = array[source_bands.index(band_number)].astype("float32")
        layer_valid = build_valid_mask(layer, nodata)
        if mask_outside_aoi and aoi_mask is not None:
            layer_valid &= aoi_mask
        stack[label] = layer
        valid &= layer_valid

    return {
        "bands": stack,
        "valid_mask": valid,
        "transform": clipped["transform"],
        "crs": clipped["crs"],
        "shape": clipped["shape"],
        "clip_bounds": clipped.get("clip_bounds"),
        "clip_bounds_lonlat": clipped.get("clip_bounds_lonlat"),
        "pixel_area_ha": clipped.get("pixel_area_ha"),
        "nodata": nodata,
        "decimation": clipped.get("decimation", 1.0),
        "decimated": clipped.get("decimated", False),
        "source_shape": clipped.get("source_shape"),
        "source": clipped.get("source"),
        "aoi_mask": aoi_mask,
        "aoi_feature_count": clipped.get("aoi_feature_count"),
        "aoi_coverage_pct": None if aoi_mask is None else round(float(aoi_mask.mean() * 100), 3),
        "applied_scaling": clipped.get("applied_scaling", False),
    }


def extract_band(loaded: Mapping[str, Any], band: int) -> np.ndarray:
    """Return one band as a 2D array from a ``load_raster`` result."""
    array = np.asarray(loaded["array"])
    bands = list(loaded["bands"])
    if band not in bands:
        raise RasterError(f"Band {band} is not loaded (available: {bands})")
    index = bands.index(band)
    return array[index] if array.ndim == 3 else array


def extract_bands(loaded: Mapping[str, Any], band_map: Mapping[str, int]) -> Dict[str, np.ndarray]:
    """Extract several named bands from one loaded raster."""
    return {label: extract_band(loaded, band) for label, band in band_map.items()}


def band_nodata_mask(bands: Iterable[np.ndarray], nodata: float | None) -> np.ndarray:
    """Combined validity mask across a set of bands."""
    masks = [build_valid_mask(band, nodata) for band in bands]
    if not masks:
        raise DataError("At least one band is required")
    return combine_valid_masks(*masks)


# --------------------------------------------------------------------------- #
# clipping / resizing / decimation
# --------------------------------------------------------------------------- #
def clip_array(array: np.ndarray, bounds: Tuple[int, int, int, int]) -> np.ndarray:
    """Clip an array with ``(row_min, row_max, col_min, col_max)`` bounds."""
    row_min, row_max, col_min, col_max = bounds
    data = np.asarray(array)
    if data.ndim == 2:
        return data[row_min:row_max, col_min:col_max]
    return data[:, row_min:row_max, col_min:col_max]


def resize_array(array: np.ndarray, out_shape: tuple[int, int], method: str = "bilinear") -> np.ndarray:
    """Resize a 2D/3D array using rasterio's resampling (no OpenCV dependency)."""
    from rasterio.enums import Resampling

    data = np.asarray(array)
    resampling = getattr(Resampling, method, Resampling.bilinear)
    if data.ndim == 2:
        return _resample(data, out_shape, resampling)
    return np.stack([_resample(data[index], out_shape, resampling) for index in range(data.shape[0])])


def _resample(band: np.ndarray, out_shape: tuple[int, int], resampling: Any) -> np.ndarray:
    height, width = out_shape
    with rasterio.io.MemoryFile() as memory:
        with memory.open(
            driver="GTiff",
            height=band.shape[0],
            width=band.shape[1],
            count=1,
            dtype="float32",
        ) as dataset:
            dataset.write(band.astype("float32"), 1)
        with memory.open() as dataset:
            return dataset.read(1, out_shape=(height, width), resampling=resampling)


def decimation_factor(shape: tuple[int, int], max_pixels: int) -> float:
    """Linear factor (<= 1) that brings ``shape`` under ``max_pixels``."""
    height, width = shape
    total = height * width
    if total <= max_pixels or total == 0:
        return 1.0
    return float(np.sqrt(max_pixels / total))


def decimate_for_analysis(
    array: np.ndarray,
    transform: Any,
    max_pixels: int,
) -> Dict[str, Any]:
    """Decimate a georeferenced array (and its transform) to a pixel budget."""
    data = np.asarray(array)
    shape = (data.shape[-2], data.shape[-1])
    factor = decimation_factor(shape, max_pixels)
    if factor >= 1.0:
        return {"array": data, "transform": transform, "factor": 1.0, "shape": shape}
    out_shape = (max(1, int(round(shape[0] * factor))), max(1, int(round(shape[1] * factor))))
    resized = resize_array(data, out_shape, method="bilinear")
    scaled_transform = transform * rasterio.Affine.scale(shape[1] / out_shape[1], shape[0] / out_shape[0])
    return {"array": resized, "transform": scaled_transform, "factor": factor, "shape": out_shape}


# --------------------------------------------------------------------------- #
# normalisation / display preparation
# --------------------------------------------------------------------------- #
def normalise(
    array: np.ndarray,
    valid: np.ndarray | None = None,
    method: str = "minmax",
    percentiles: tuple[float, float] = (2.0, 98.0),
    out_range: tuple[float, float] = (0.0, 1.0),
) -> np.ndarray:
    """Normalise to ``out_range`` without touching the source array.

    Methods:
      * ``minmax``      - full dynamic range
      * ``percentile``  - robust stretch (default for imagery)
      * ``reflectance`` - treat input as reflectance already in [0, 1]
    """
    data = np.asarray(array, dtype="float32").copy()
    mask = np.asarray(valid, dtype=bool) if valid is not None else np.isfinite(data)
    if not mask.any():
        return np.full_like(data, out_range[0])
    values = data[mask]
    if method == "minmax":
        low, high = float(np.min(values)), float(np.max(values))
    elif method == "percentile":
        low, high = (float(np.percentile(values, percentiles[0])), float(np.percentile(values, percentiles[1])))
    elif method == "reflectance":
        low, high = 0.0, 1.0
    else:
        raise DataError(f"Unknown normalisation method '{method}'")
    if high <= low:
        high = low + 1e-6
    scaled = (data - low) / (high - low)
    scaled = np.clip(scaled, 0.0, 1.0)
    span = out_range[1] - out_range[0]
    scaled = scaled * span + out_range[0]
    scaled[~mask] = out_range[0]
    return scaled


def to_uint8(
    array: np.ndarray,
    valid: np.ndarray | None = None,
    percentiles: tuple[float, float] = (2.0, 98.0),
) -> np.ndarray:
    """Percentile-stretched uint8 copy for display and OpenCV input."""
    return (normalise(array, valid, method="percentile", percentiles=percentiles) * 255.0).astype("uint8")


def composite_rgb(stack: Mapping[str, np.ndarray], valid: np.ndarray | None = None) -> np.ndarray:
    """True-colour RGB composite (H, W, 3 uint8) from a named band stack."""
    for required in ("red", "green", "blue"):
        if required not in stack:
            raise DataError(f"RGB composite requires a '{required}' band")
    channels = [to_uint8(stack[channel], valid) for channel in ("red", "green", "blue")]
    return np.dstack(channels)


def composite_false_colour(stack: Mapping[str, np.ndarray], valid: np.ndarray | None = None) -> np.ndarray:
    """NIR-Red-Green false colour composite (vegetation appears red)."""
    for required in ("nir", "red", "green"):
        if required not in stack:
            raise DataError("False colour composite requires nir, red and green bands")
    channels = [to_uint8(stack[channel], valid) for channel in ("nir", "red", "green")]
    return np.dstack(channels)


def single_band_preview(array: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """Grayscale uint8 preview of a single band."""
    return to_uint8(array, valid)


def apply_mask(stack: Mapping[str, Any], valid: np.ndarray) -> Dict[str, np.ndarray]:
    """Return band arrays with invalid pixels set to NaN (never in place)."""
    return {label: mask_to_nan(values, valid) for label, values in stack["bands"].items()}


def prepare_for_analysis(
    loaded: Mapping[str, Any],
    max_pixels: int = 4_000_000,
) -> Dict[str, Any]:
    """Decimate a loaded raster stack to the analysis pixel budget."""
    array = np.asarray(loaded["array"])
    if array.ndim == 2:
        array = array[np.newaxis, :, :]
    result = decimate_for_analysis(array, loaded["transform"], max_pixels)
    return {
        **{k: v for k, v in loaded.items() if k not in {"array", "transform", "shape"}},
        "array": result["array"],
        "transform": result["transform"],
        "shape": result["shape"],
        "decimation": round(1.0 / result["factor"], 4) if result["factor"] < 1 else 1.0,
        "decimated": bool(result["factor"] < 1.0),
    }


def describe_array(array: np.ndarray, valid: np.ndarray | None = None) -> Dict[str, Any]:
    """Small diagnostic summary (shape, dtype, nan/min/max) for responses."""
    data = np.asarray(array, dtype="float32")
    mask = np.asarray(valid, dtype=bool) if valid is not None else np.isfinite(data)
    values = data[mask]
    return {
        "shape": [int(v) for v in data.shape],
        "dtype": str(np.asarray(array).dtype),
        "valid_pixels": int(values.size),
        "total_pixels": int(data.size),
        "min": float(np.min(values)) if values.size else None,
        "max": float(np.max(values)) if values.size else None,
        "mean": float(np.mean(values)) if values.size else None,
    }


def load_and_prepare(path: str, bands: Sequence[int] | None = None, max_pixels: int = 4_000_000) -> Dict[str, Any]:
    """Convenience: load a raster and decimate it to the analysis budget."""
    loaded = load_raster(path, bands=bands)
    return prepare_for_analysis(loaded, max_pixels=max_pixels)
