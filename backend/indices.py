"""Vegetation index engine.

NDVI is the primary, fully-tested index. NDRE, EVI and SAVI share the same code
path so switching indices is a configuration change rather than a rewrite.

    NDVI = (NIR - RED) / (NIR + RED)
    NDRE = (NIR - RED_EDGE) / (NIR + RED_EDGE)
    EVI  = G * (NIR - RED) / (NIR + C1*RED - C2*BLUE + L)
    SAVI = (NIR - RED) / (NIR + RED + L) * (1 + L)

Band selection is explicit and always reported back to the caller - Vibes Lite
never silently assumes a band order without stating how it decided.
"""
from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Mapping, Sequence

import numpy as np

from config import fallback_band_map
from data import DataError

VALID_RANGE = (-1.0, 1.0)


class VegetationIndexError(DataError):
    """Raised when an index cannot be computed from the available bands."""


# Backwards-friendly alias used internally below.
IndexError_ = VegetationIndexError


# --------------------------------------------------------------------------- #
# band resolution
# --------------------------------------------------------------------------- #
#: Tokens that identify a physical band inside raster band descriptions/tags.
BAND_TOKENS: Dict[str, List[str]] = {
    "blue": ["blue", "b02", "b2", "band2", "band_2"],
    "green": ["green", "b03", "b3", "band3", "band_3"],
    "red": ["red", "b04", "b4", "band4", "band_4"],
    "red_edge": ["rededge", "red_edge", "red edge", "b05", "b5", "band5", "band_5", "b06", "b6", "b07", "b7"],
    "nir": ["nir", "b08", "b8", "band8", "band_8", "b8a", "nir08", "nearinfrared"],
    # SWIR is split by centre wavelength: B11 (~1610 nm) drives moisture and
    # burn indices, B12 (~2190 nm) drives clay/mineral indices. A bare "swir"
    # description is treated as SWIR1, which is the common case.
    "swir1": ["swir1", "swir_1", "b11", "band11", "band_11", "swir"],
    "swir2": ["swir2", "swir_2", "b12", "band12", "band_12"],
}


def _normalise_token(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def detect_bands(metadata: Mapping[str, Any]) -> Dict[str, int]:
    """Infer physical band numbers from raster band descriptions/tags."""
    descriptions = metadata.get("band_descriptions") or []
    band_tags = metadata.get("band_tags") or {}
    found: Dict[str, int] = {}
    for index in range(1, int(metadata.get("band_count", 0)) + 1):
        candidates = [descriptions[index - 1] if index - 1 < len(descriptions) else ""]
        for key, value in (band_tags.get(str(index)) or {}).items():
            candidates.extend([key, value])
        tokens = {_normalise_token(item) for item in candidates if item}
        for band, needles in BAND_TOKENS.items():
            if band in found:
                continue
            if tokens & {_normalise_token(needle) for needle in needles}:
                found[band] = index
    # B8A is NIR but is conventionally listed after B08; keep the first match.
    return found


def resolve_band_map(
    metadata: Mapping[str, Any],
    requested: Mapping[str, int] | None = None,
) -> Dict[str, Any]:
    """Decide which raster band feeds each physical band.

    Precedence: explicit request > band descriptions/tags > configured fallback
    (1-based, Blue/Green/Red/NIR order). The method is always reported so the
    user can see exactly which pixels were used.
    """
    band_count = int(metadata.get("band_count", 0))
    resolved: Dict[str, int] = {}
    notes: List[str] = []
    method = "explicit"

    if requested:
        for label, value in requested.items():
            if value is None:
                continue
            band_number = int(value)
            if band_number < 1 or band_number > band_count:
                raise IndexError_(f"Requested band {band_number} for '{label}' but the raster has {band_count} band(s)")
            resolved[label] = band_number
        notes.append("Band mapping supplied with the request.")
    else:
        detected = detect_bands(metadata)
        if detected:
            method = "band_descriptions"
            resolved.update(detected)
            notes.append(
                "Band mapping inferred from raster band descriptions: "
                + ", ".join(f"{k}=B{v}" for k, v in sorted(detected.items()))
            )
        else:
            fallback = fallback_band_map()
            unusable = {band: number for band, number in fallback.items() if number > band_count}
            if unusable:
                raise VegetationIndexError(
                    f"Band mapping could not be inferred and the configured fallback "
                    f"({', '.join(f'{k}={v}' for k, v in sorted(fallback.items()))}) does not fit a "
                    f"{band_count}-band raster. Pass an explicit band_map (e.g. {{\"red\": 1, \"nir\": 2}}) "
                    "or add band descriptions to the GeoTIFF."
                )
            method = "config_fallback"
            resolved.update(fallback)
            notes.append(
                "Raster carries no usable band descriptions; fell back to the configured band order "
                f"({', '.join(f'{k}={v}' for k, v in sorted(fallback.items()))}, 1-based)."
            )

    return {
        "bands": resolved,
        "method": method,
        "notes": notes,
        "band_descriptions": list(metadata.get("band_descriptions") or []),
        "assumption_warning": method == "config_fallback",
    }


def required_bands(index_name: str) -> List[str]:
    return list(INDEX_REGISTRY[index_name.upper()]["bands"])


# --------------------------------------------------------------------------- #
# safe maths
# --------------------------------------------------------------------------- #
def safe_divide(numerator: np.ndarray, denominator: np.ndarray, fill: float = 0.0) -> np.ndarray:
    """Element-wise division that never raises and never returns inf."""
    top = np.asarray(numerator, dtype="float32")
    bottom = np.asarray(denominator, dtype="float32")
    result = np.full(np.broadcast(top, bottom).shape, fill, dtype="float32")
    with np.errstate(divide="ignore", invalid="ignore"):
        valid = np.isfinite(bottom) & (np.abs(bottom) > 1e-6)
        np.divide(top, bottom, out=result, where=valid)
    result[~np.isfinite(result)] = fill
    return result


def clip_index(array: np.ndarray, limits: tuple[float, float] = VALID_RANGE) -> np.ndarray:
    """Clip an index to its physically valid range, preserving NaN."""
    data = np.asarray(array, dtype="float32")
    return np.clip(data, limits[0], limits[1])


# --------------------------------------------------------------------------- #
# index computations
# --------------------------------------------------------------------------- #
def compute_ndvi(red: np.ndarray, nir: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """NDVI = (NIR - RED) / (NIR + RED), safe for zero denominators."""
    red_values = np.asarray(red, dtype="float32")
    nir_values = np.asarray(nir, dtype="float32")
    ndvi = safe_divide(nir_values - red_values, nir_values + red_values, fill=0.0)
    ndvi = clip_index(ndvi)
    if valid is not None:
        ndvi = ndvi.copy()
        ndvi[~np.asarray(valid, dtype=bool)] = np.nan
    return ndvi


def compute_ndre(nir: np.ndarray, red_edge: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """NDRE = (NIR - RED_EDGE) / (NIR + RED_EDGE) - sensitive to canopy density."""
    values_nir = np.asarray(nir, dtype="float32")
    values_edge = np.asarray(red_edge, dtype="float32")
    ndre = clip_index(safe_divide(values_nir - values_edge, values_nir + values_edge, fill=0.0))
    if valid is not None:
        ndre = ndre.copy()
        ndre[~np.asarray(valid, dtype=bool)] = np.nan
    return ndre


def compute_evi(nir: np.ndarray, red: np.ndarray, blue: np.ndarray, gain: float = 2.5, c1: float = 6.0, c2: float = 7.5, l: float = 1.0, valid: np.ndarray | None = None) -> np.ndarray:
    """Enhanced Vegetation Index with atmospheric/aerosol correction."""
    values_nir = np.asarray(nir, dtype="float32")
    values_red = np.asarray(red, dtype="float32")
    values_blue = np.asarray(blue, dtype="float32")
    denominator = values_nir + c1 * values_red - c2 * values_blue + l
    evi = gain * safe_divide(values_nir - values_red, denominator, fill=0.0)
    evi = clip_index(evi)
    if valid is not None:
        evi = evi.copy()
        evi[~np.asarray(valid, dtype=bool)] = np.nan
    return evi


def compute_savi(nir: np.ndarray, red: np.ndarray, l: float = 0.5, valid: np.ndarray | None = None) -> np.ndarray:
    """Soil-Adjusted Vegetation Index (reduces soil background influence)."""
    values_nir = np.asarray(nir, dtype="float32")
    values_red = np.asarray(red, dtype="float32")
    savi = safe_divide(values_nir - values_red, values_nir + values_red + l, fill=0.0) * (1.0 + l)
    savi = clip_index(savi)
    if valid is not None:
        savi = savi.copy()
        savi[~np.asarray(valid, dtype=bool)] = np.nan
    return savi


def _mask_invalid(array: np.ndarray, valid: np.ndarray | None) -> np.ndarray:
    """NaN out pixels outside the valid mask, leaving the array otherwise intact."""
    if valid is None:
        return array
    masked = np.array(array, dtype="float32", copy=True)
    masked[~np.asarray(valid, dtype=bool)] = np.nan
    return masked


def compute_gndvi(nir: np.ndarray, green: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """GNDVI = (NIR - GREEN) / (NIR + GREEN).

    Uses the green band instead of red, which makes it roughly twice as
    sensitive to chlorophyll concentration as NDVI — the usual choice for
    nitrogen-status work on a closed canopy.
    """
    values_nir = np.asarray(nir, dtype="float32")
    values_green = np.asarray(green, dtype="float32")
    gndvi = clip_index(safe_divide(values_nir - values_green, values_nir + values_green, fill=0.0))
    return _mask_invalid(gndvi, valid)


def compute_ndmi(nir: np.ndarray, swir1: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """NDMI = (NIR - SWIR1) / (NIR + SWIR1) — canopy water content.

    Falls when leaf water drops, so it separates a drought-stressed canopy from
    a nitrogen-stressed one, which NDVI alone cannot do.
    """
    values_nir = np.asarray(nir, dtype="float32")
    values_swir = np.asarray(swir1, dtype="float32")
    ndmi = clip_index(safe_divide(values_nir - values_swir, values_nir + values_swir, fill=0.0))
    return _mask_invalid(ndmi, valid)


def compute_ndwi(green: np.ndarray, nir: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """NDWI = (GREEN - NIR) / (GREEN + NIR) — open water and surface moisture.

    Positive over water and saturated soil, negative over dry vegetation.
    """
    values_green = np.asarray(green, dtype="float32")
    values_nir = np.asarray(nir, dtype="float32")
    ndwi = clip_index(safe_divide(values_green - values_nir, values_green + values_nir, fill=0.0))
    return _mask_invalid(ndwi, valid)


def compute_osavi(nir: np.ndarray, red: np.ndarray, l: float = 0.16, valid: np.ndarray | None = None) -> np.ndarray:
    """OSAVI = 1.16 * (NIR - RED) / (NIR + RED + 0.16).

    The optimised soil-adjusted variant: uses a fixed 0.16 soil-brightness
    correction, which is the value established for agricultural canopies.
    """
    values_nir = np.asarray(nir, dtype="float32")
    values_red = np.asarray(red, dtype="float32")
    osavi = safe_divide(values_nir - values_red, values_nir + values_red + l, fill=0.0) * (1.0 + l)
    return _mask_invalid(clip_index(osavi), valid)


def compute_msavi(nir: np.ndarray, red: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """MSAVI2 = (2*NIR + 1 - sqrt((2*NIR + 1)^2 - 8*(NIR - RED))) / 2.

    Self-adjusting soil line: unlike SAVI the correction is derived from the
    pixels themselves rather than a fixed L, so it holds up across a field with
    variable soil brightness, and it saturates later than NDVI.
    """
    values_nir = np.asarray(nir, dtype="float32")
    values_red = np.asarray(red, dtype="float32")
    term = 2.0 * values_nir + 1.0
    radicand = term**2 - 8.0 * (values_nir - values_red)
    # A negative radicand is not physically meaningful; NaN it out explicitly
    # rather than letting sqrt emit a warning and an undefined value.
    root = np.full_like(radicand, np.nan, dtype="float32")
    positive = np.isfinite(radicand) & (radicand >= 0)
    np.sqrt(radicand, out=root, where=positive)
    msavi = clip_index((term - root) / 2.0)
    return _mask_invalid(msavi, valid)


def compute_psri(red: np.ndarray, green: np.ndarray, blue: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """PSRI = (RED - GREEN) / BLUE — plant senescence reflectance index.

    Rises as chlorophyll degrades and carotenoids take over, so it tracks
    ripening and senescence where NDVI has already flattened out.
    """
    values_red = np.asarray(red, dtype="float32")
    values_green = np.asarray(green, dtype="float32")
    values_blue = np.asarray(blue, dtype="float32")
    psri = clip_index(safe_divide(values_red - values_green, values_blue, fill=0.0))
    return _mask_invalid(psri, valid)


def compute_cvi(red: np.ndarray, green: np.ndarray, nir: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """CVI = NIR * RED / GREEN^2 — chlorophyll vegetation index.

    Ratiometric in green, so it is comparatively insensitive to illumination
    and viewing geometry — useful on drone mosaics with uneven exposure.
    """
    values_red = np.asarray(red, dtype="float32")
    values_green = np.asarray(green, dtype="float32")
    values_nir = np.asarray(nir, dtype="float32")
    cvi = safe_divide(values_nir * values_red, values_green**2, fill=0.0)
    return _mask_invalid(cvi, valid)


def compute_reci(nir: np.ndarray, red_edge: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """RECI = NIR / RED_EDGE - 1 — red-edge chlorophyll index.

    A simple ratio rather than a normalised difference, which keeps its
    sensitivity at the high end of the canopy range where NDVI saturates.
    """
    values_nir = np.asarray(nir, dtype="float32")
    values_edge = np.asarray(red_edge, dtype="float32")
    reci = safe_divide(values_nir, values_edge, fill=0.0) - 1.0
    # A ratio index is unbounded; 0-10 keeps the colour ramp meaningful without
    # discarding real high-end values the way clipping to [-1, 1] would.
    return _mask_invalid(np.clip(reci, 0.0, 10.0), valid)


def compute_gci(nir: np.ndarray, green: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """GCI = NIR / GREEN - 1 — green chlorophyll index.

    The green-band sibling of RECI; needs no red-edge band, so it works on
    ordinary RGB+NIR drone payloads.
    """
    values_nir = np.asarray(nir, dtype="float32")
    values_green = np.asarray(green, dtype="float32")
    gci = safe_divide(values_nir, values_green, fill=0.0) - 1.0
    return _mask_invalid(np.clip(gci, 0.0, 10.0), valid)


#: Registry of available indices. ``bands`` drives band resolution; ``callable``
#: keeps the dispatch explicit rather than relying on name-based if/else chains.
INDEX_REGISTRY: Dict[str, Dict[str, Any]] = {
    "NDVI": {
        "name": "NDVI",
        "label": "Normalized Difference Vegetation Index",
        "bands": ["red", "nir"],
        "callable": compute_ndvi,
        "range": [-1.0, 1.0],
        "normalized": True,
        "typical_vegetation_range": [0.2, 0.9],
        "sensor_hint": "Requires a red and a near-infrared band (Sentinel-2 B04/B08, Landsat 4/5, drone NIR).",
        "notes": "Primary index. Unaffected by soil brightness for full canopies, but saturates above ~0.8.",
    },
    "NDRE": {
        "name": "NDRE",
        "label": "Normalized Difference Red Edge",
        "bands": ["nir", "red_edge"],
        "callable": compute_ndre,
        "range": [-1.0, 1.0],
        "normalized": True,
        "typical_vegetation_range": [0.1, 0.6],
        "sensor_hint": "Needs a red-edge band (Sentinel-2 B05/B06/B07 or MicaSense RedEdge).",
        "notes": "Better than NDVI for mature, dense canopies and chlorophyll content.",
    },
    "EVI": {
        "name": "EVI",
        "label": "Enhanced Vegetation Index",
        "bands": ["blue", "red", "nir"],
        "callable": compute_evi,
        "range": [-1.0, 1.0],
        "normalized": True,
        "typical_vegetation_range": [0.1, 0.8],
        "sensor_hint": "Needs blue, red and NIR bands with reflectance values in 0-1.",
        "notes": "Reduces atmospheric and soil noise; expects scaled reflectance, not raw DN.",
    },
    "SAVI": {
        "name": "SAVI",
        "label": "Soil-Adjusted Vegetation Index",
        "bands": ["red", "nir"],
        "callable": compute_savi,
        "range": [-1.0, 1.0],
        "normalized": True,
        "typical_vegetation_range": [0.1, 0.8],
        "sensor_hint": "Needs red and NIR bands.",
        "notes": "Useful on sparse canopies where exposed soil biases NDVI.",
    },
    "GNDVI": {
        "name": "GNDVI",
        "label": "Green Normalized Difference Vegetation Index",
        "bands": ["green", "nir"],
        "callable": compute_gndvi,
        "range": [-1.0, 1.0],
        "normalized": True,
        "typical_vegetation_range": [0.15, 0.8],
        "sensor_hint": "Needs green and NIR bands.",
        "notes": "More sensitive to chlorophyll than NDVI; the usual choice for nitrogen status on a closed canopy.",
    },
    "NDMI": {
        "name": "NDMI",
        "label": "Normalized Difference Moisture Index",
        "bands": ["nir", "swir1"],
        "callable": compute_ndmi,
        "range": [-1.0, 1.0],
        "normalized": True,
        "typical_vegetation_range": [-0.1, 0.6],
        "sensor_hint": "Needs NIR and SWIR1 (Sentinel-2 B08/B11, Landsat 5/7/8/9).",
        "notes": "Canopy water content — separates drought stress from nitrogen stress where NDVI cannot.",
    },
    "NDWI": {
        "name": "NDWI",
        "label": "Normalized Difference Water Index",
        "bands": ["green", "nir"],
        "callable": compute_ndwi,
        "range": [-1.0, 1.0],
        "normalized": True,
        "typical_vegetation_range": [-0.6, 0.1],
        "sensor_hint": "Needs green and NIR bands.",
        "notes": "Positive over open water and saturated soil; used to find ponding and drainage problems.",
    },
    "OSAVI": {
        "name": "OSAVI",
        "label": "Optimized Soil-Adjusted Vegetation Index",
        "bands": ["red", "nir"],
        "callable": compute_osavi,
        "range": [-1.0, 1.0],
        "normalized": True,
        "typical_vegetation_range": [0.1, 0.9],
        "sensor_hint": "Needs red and NIR bands.",
        "notes": "Fixed 0.16 soil-brightness correction — the standard soil-adjusted index for agricultural canopies.",
    },
    "MSAVI": {
        "name": "MSAVI",
        "label": "Modified Soil-Adjusted Vegetation Index (MSAVI2)",
        "bands": ["red", "nir"],
        "callable": compute_msavi,
        "range": [-1.0, 1.0],
        "normalized": True,
        "typical_vegetation_range": [0.1, 0.9],
        "sensor_hint": "Needs red and NIR bands.",
        "notes": "Self-adjusting soil line and later saturation than NDVI — the best default on sparse or patchy emergence.",
    },
    "PSRI": {
        "name": "PSRI",
        "label": "Plant Senescence Reflectance Index",
        "bands": ["red", "green", "blue"],
        "callable": compute_psri,
        "range": [-1.0, 1.0],
        "normalized": True,
        "typical_vegetation_range": [-0.2, 0.6],
        "sensor_hint": "Needs red, green and blue bands (any RGB sensor).",
        "notes": "Tracks ripening and senescence after NDVI has flattened — useful for harvest timing.",
    },
    "CVI": {
        "name": "CVI",
        "label": "Chlorophyll Vegetation Index",
        "bands": ["red", "green", "nir"],
        "callable": compute_cvi,
        "range": [0.0, 10.0],
        "normalized": False,  # a green/red-edge ratio: unbounded above, never negative
        "typical_vegetation_range": [0.5, 8.0],
        "sensor_hint": "Needs red, green and NIR bands.",
        "notes": "Ratiometric in green, so it tolerates uneven illumination across a drone mosaic.",
    },
    "RECI": {
        "name": "RECI",
        "label": "Red-Edge Chlorophyll Index",
        "bands": ["nir", "red_edge"],
        "callable": compute_reci,
        "range": [0.0, 10.0],
        "normalized": False,  # a green/red-edge ratio: unbounded above, never negative
        "typical_vegetation_range": [0.5, 6.0],
        "sensor_hint": "Needs a red-edge band (Sentinel-2 B05/B06/B07, MicaSense RedEdge).",
        "notes": "Stays sensitive in dense canopies where normalised indices saturate.",
    },
    "GCI": {
        "name": "GCI",
        "label": "Green Chlorophyll Index",
        "bands": ["green", "nir"],
        "callable": compute_gci,
        "range": [0.0, 10.0],
        "normalized": False,  # a green/red-edge ratio: unbounded above, never negative
        "typical_vegetation_range": [0.5, 6.0],
        "sensor_hint": "Needs green and NIR bands — works on ordinary RGB+NIR drone payloads.",
        "notes": "The green-band sibling of RECI, for sensors without a red-edge band.",
    },
}


def available_indices() -> List[Dict[str, Any]]:
    """Public description of every index (for the UI and the API)."""
    return [
        {key: value for key, value in spec.items() if key != "callable"}
        for spec in INDEX_REGISTRY.values()
    ]


def normalise_index_name(name: str | None) -> str:
    candidate = (name or "NDVI").strip().upper()
    if candidate not in INDEX_REGISTRY:
        raise IndexError_(f"Unknown index '{name}'. Available: {', '.join(INDEX_REGISTRY)}")
    return candidate


def compute_index(
    index_name: str,
    bands: Mapping[str, np.ndarray],
    valid: np.ndarray | None = None,
) -> Dict[str, Any]:
    """Compute a named index from a mapping of physical bands."""
    name = normalise_index_name(index_name)
    spec = INDEX_REGISTRY[name]
    missing = [band for band in spec["bands"] if band not in bands]
    if missing:
        raise IndexError_(
            f"{name} requires band(s) {', '.join(spec['bands'])}; missing: {', '.join(missing)}"
        )
    values = {
        band: np.asarray(bands[band], dtype="float32")
        for band in spec["bands"]
    }
    if valid is not None:
        validity = np.asarray(valid, dtype=bool)
        values = {band: np.where(validity, array, np.nan) for band, array in values.items()}
    computed = spec["callable"](**values)
    return {
        "name": name,
        "label": spec["label"],
        "array": computed,
        "range": spec["range"],
        "normalized": spec["normalized"],
        "formula": spec.get("formula", ""),
        "bands_used": list(spec["bands"]),

        "notes": spec["notes"],
        "sensor_hint": spec["sensor_hint"],
    }


# --------------------------------------------------------------------------- #
# statistics
# --------------------------------------------------------------------------- #
def index_statistics(
    array: np.ndarray,
    valid: np.ndarray | None = None,
    percentiles: Sequence[float] = (5, 25, 50, 75, 95),
    histogram_bins: int = 20,
) -> Dict[str, Any]:
    """Nan-aware statistics for an index raster, including a histogram."""
    data = np.asarray(array, dtype="float32")
    mask = np.asarray(valid, dtype=bool) if valid is not None else np.isfinite(data)
    mask &= np.isfinite(data)
    values = data[mask]
    total = int(data.size)
    if values.size == 0:
        return {
            "valid_pixels": 0,
            "total_pixels": total,
            "valid_ratio": 0.0,
            "min": None,
            "max": None,
            "mean": None,
            "median": None,
            "std": None,
            "percentiles": {},
            "histogram": {"bins": [], "counts": []},
            "classes": {"negative_or_water": 0.0, "bare_soil": 0.0, "sparse_vegetation": 0.0, "moderate_vegetation": 0.0, "dense_vegetation": 0.0},
        }

    percentile_map = {f"p{int(p)}": round(float(np.percentile(values, p)), 4) for p in percentiles}
    counts, edges = np.histogram(values, bins=int(histogram_bins), range=(-1.0, 1.0))
    return {
        "valid_pixels": int(values.size),
        "total_pixels": total,
        "valid_ratio": round(float(values.size / total), 5) if total else 0.0,
        "min": round(float(np.min(values)), 4),
        "max": round(float(np.max(values)), 4),
        "mean": round(float(np.mean(values)), 4),
        "median": round(float(np.median(values)), 4),
        "std": round(float(np.std(values)), 4),
        "variance": round(float(np.var(values)), 6),
        "p2": round(float(np.percentile(values, 2)), 4),
        "p98": round(float(np.percentile(values, 98)), 4),
        "percentiles": percentile_map,
        "histogram": {
            "bins": [round(float(edge), 4) for edge in edges],
            "counts": [int(count) for count in counts],
        },
        "classes": generalised_ndvi_classes(values),
    }


def generalised_ndvi_classes(values: np.ndarray) -> Dict[str, float]:
    """Share of pixels in widely used NDVI interpretation bands (percent)."""
    data = np.asarray(values, dtype="float32")
    if data.size == 0:
        return {}
    return {
        "negative_or_water": round(float((data < 0.0).mean() * 100), 3),
        "bare_soil": round(float(((data >= 0.0) & (data < 0.2)).mean() * 100), 3),
        "sparse_vegetation": round(float(((data >= 0.2) & (data < 0.4)).mean() * 100), 3),
        "moderate_vegetation": round(float(((data >= 0.4) & (data < 0.6)).mean() * 100), 3),
        "dense_vegetation": round(float((data >= 0.6).mean() * 100), 3),
    }


def compare_index_statistics(before: Mapping[str, Any], after: Mapping[str, Any]) -> Dict[str, Any]:
    """Delta between two index statistics blocks (used by change detection)."""
    delta: Dict[str, Any] = {}
    for key in ("mean", "median", "min", "max", "std"):
        first, second = before.get(key), after.get(key)
        if first is None or second is None:
            delta[key] = None
            continue
        delta[key] = round(float(second) - float(first), 4)
    first_mean = before.get("mean")
    if first_mean not in (None, 0):
        delta["mean_change_pct"] = round((float(after.get("mean", 0)) - float(first_mean)) / abs(float(first_mean)) * 100, 2)
    else:
        delta["mean_change_pct"] = None
    return delta


def classify_index_pixel(value: float) -> str:
    """Human-readable label for a single index value (NDVI conventions)."""
    if value is None or not np.isfinite(value):
        return "unknown"
    if value < 0.0:
        return "negative_or_water"
    if value < 0.2:
        return "bare_soil"
    if value < 0.4:
        return "sparse_vegetation"
    if value < 0.6:
        return "moderate_vegetation"
    return "dense_vegetation"
