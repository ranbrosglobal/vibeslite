"""Crop-health analysis engine.

A deliberately simple, explainable health model built on top of a vegetation
index. Thresholds come from ``config.yaml`` (``crop_health.thresholds``) and are
never hard-coded here, so an agronomist can re-tune the classes for a crop
without touching code.

Honesty rule: NDVI describes canopy greenness/density. This module reports
"vegetation vigour" classes and weak-vegetation regions - it never claims to
diagnose a disease, pest or nutrient deficiency from an index alone.
"""
from __future__ import annotations

from typing import Any, Dict, List, Mapping, Sequence

import numpy as np

from config import get_config, health_thresholds
from data import DataError
from geospatial import mask_to_polygons
from indices import index_statistics, safe_divide
import opencv as cv

# --------------------------------------------------------------------------- #
# class definitions (single source of truth for colours + wording)
# --------------------------------------------------------------------------- #
#: Ordered from worst to best. Index 0..4 is used for the class raster.
HEALTH_CLASSES: List[Dict[str, Any]] = [
    {
        "key": "very_low",
        "label": "Very low vegetation",
        "short": "Very low",
        "colour": "#8c3a1f",
        "hex": "#8c3a1f",
        "severity": "high",
        "description": "Bare soil, senescent or severely stressed canopy. Very little active green biomass.",
    },
    {
        "key": "low",
        "label": "Low vegetation",
        "short": "Low",
        "colour": "#c07a1e",
        "hex": "#c07a1e",
        "severity": "elevated",
        "description": "Sparse or stressed canopy. Often early emergence, poor establishment or localised stress.",
    },
    {
        "key": "moderate",
        "label": "Moderate vegetation",
        "short": "Moderate",
        "colour": "#c9b03c",
        "hex": "#c9b03c",
        "severity": "watch",
        "description": "Developing canopy with partial ground cover. Expect a mix of soil and leaf signal.",
    },
    {
        "key": "healthy",
        "label": "Healthy vegetation",
        "short": "Healthy",
        "colour": "#4f9d5d",
        "hex": "#4f9d5d",
        "severity": "low",
        "description": "Well developed, photosynthetically active canopy.",
    },
    {
        "key": "very_healthy",
        "label": "Very healthy vegetation",
        "short": "Very healthy",
        "colour": "#1d6b3c",
        "hex": "#1d6b3c",
        "severity": "none",
        "description": "Dense, vigorous canopy at or near full cover for the observed crop stage.",
    },
]


def health_class_keys() -> List[str]:
    return [entry["key"] for entry in HEALTH_CLASSES]


def health_class_boundaries(thresholds: Mapping[str, float] | None = None) -> List[float]:
    """Ascending NDVI breakpoints between the classes (4 values for 5 classes)."""
    values = thresholds or health_thresholds()
    return [float(values["very_low"]), float(values["low"]), float(values["moderate"]), float(values["healthy"])]


def thresholds_from_config() -> Dict[str, float]:
    """Class boundaries currently configured (exposed through the API)."""
    return health_thresholds()


# --------------------------------------------------------------------------- #
# classification
# --------------------------------------------------------------------------- #
def classify_health(
    ndvi: np.ndarray,
    thresholds: Mapping[str, float] | None = None,
    valid: np.ndarray | None = None,
) -> np.ndarray:
    """Classify an NDVI array into 0..4 health classes (-1 = invalid)."""
    data = np.asarray(ndvi, dtype="float32")
    boundaries = health_class_boundaries(thresholds)
    if list(boundaries) != sorted(boundaries):
        raise DataError("Crop health thresholds must be ascending (very_low < low < moderate < healthy)")
    classes = np.digitize(data, boundaries, right=False).astype("int8")
    invalid = ~np.isfinite(data)
    if valid is not None:
        invalid |= ~np.asarray(valid, dtype=bool)
    classes[invalid] = -1
    return classes


def classify_pixel(value: float, thresholds: Mapping[str, float] | None = None) -> Dict[str, Any]:
    """Classify a single NDVI value (used by tests, notebooks and the UI)."""
    if value is None or not np.isfinite(value):
        return {"key": "unknown", "label": "No data", "index": -1}
    index = int(np.digitize(np.array([value], dtype="float32"), health_class_boundaries(thresholds))[0])
    entry = HEALTH_CLASSES[index]
    return {
        "key": entry["key"],
        "label": entry["label"],
        "index": index,
        "colour": entry["colour"],
        "range": _class_range(index, thresholds),
    }


def _class_range(index: int, thresholds: Mapping[str, float] | None = None) -> List[float | None]:
    boundaries = health_class_boundaries(thresholds)
    lower = None if index == 0 else boundaries[index - 1]
    upper = None if index == len(boundaries) else boundaries[index]
    return [lower, upper]


def health_colour_map(classes: np.ndarray) -> np.ndarray:
    """RGB rendering of a health class raster (invalid pixels = neutral grey)."""
    data = np.asarray(classes)
    rgb = np.zeros((*data.shape, 3), dtype="uint8")
    rgb[:] = (222, 220, 214)
    for index, entry in enumerate(HEALTH_CLASSES):
        colour = tuple(int(entry["colour"][pos : pos + 2], 16) for pos in (1, 3, 5))
        rgb[data == index] = colour
    return rgb


def health_statistics(
    classes: np.ndarray,
    pixel_area_ha: float | None = None,
    thresholds: Mapping[str, float] | None = None,
    field_area_ha: float | None = None,
) -> Dict[str, Any]:
    """Per-class pixel share and area for a health class raster."""
    data = np.asarray(classes)
    valid = data >= 0
    total_valid = int(valid.sum())
    entries: List[Dict[str, Any]] = []
    for index, definition in enumerate(HEALTH_CLASSES):
        pixels = int((data == index).sum())
        share = (pixels / total_valid * 100.0) if total_valid else 0.0
        area = pixels * pixel_area_ha if pixel_area_ha else None
        entries.append(
            {
                "key": definition["key"],
                "label": definition["label"],
                "short": definition["short"],
                "colour": definition["colour"],
                "severity": definition["severity"],
                "range": _class_range(index, thresholds),
                "pixels": pixels,
                "percentage": round(share, 3),
                "area_ha": round(area, 4) if area is not None else None,
            }
        )
    healthy_pixels = int(((data == 3) | (data == 4)).sum())
    weak_pixels = int(((data == 0) | (data == 1)).sum())
    return {
        "classes": entries,
        "by_key": {entry["key"]: entry for entry in entries},
        "valid_pixels": total_valid,
        "total_pixels": int(data.size),
        "coverage_pct": round(float(total_valid / data.size * 100), 3) if data.size else 0.0,
        "healthy_pct": round(healthy_pixels / total_valid * 100, 3) if total_valid else 0.0,
        "weak_pct": round(weak_pixels / total_valid * 100, 3) if total_valid else 0.0,
        "very_low_pct": entries[0]["percentage"],
        "low_pct": entries[1]["percentage"],
        "moderate_pct": entries[2]["percentage"],
        "healthy_area_ha": round(healthy_pixels * pixel_area_ha, 4) if pixel_area_ha else None,
        "weak_area_ha": round(weak_pixels * pixel_area_ha, 4) if pixel_area_ha else None,
        "analysed_area_ha": round(total_valid * pixel_area_ha, 4) if pixel_area_ha else None,
        "field_area_ha": round(field_area_ha, 4) if field_area_ha else None,
        "thresholds": dict(thresholds or health_thresholds()),
        "dominant_class": max(entries, key=lambda item: item["pixels"])["key"] if total_valid else None,
    }


# --------------------------------------------------------------------------- #
# zones / weak vegetation / anomalies
# --------------------------------------------------------------------------- #
def health_zones(
    classes: np.ndarray,
    transform: Any,
    crs: Any,
    min_area_ha: float | None = None,
    pixel_area_ha: float | None = None,
    max_zones_per_class: int = 40,
) -> Dict[str, Any]:
    """Polygonise each health class into contiguous zones with areas."""
    config = get_config().get("crop_health", {})
    minimum = min_area_ha if min_area_ha is not None else float(config.get("min_patch_area_ha", 0.05))
    data = np.asarray(classes)
    zones: Dict[str, List[Dict[str, Any]]] = {}
    for index, definition in enumerate(HEALTH_CLASSES):
        mask = data == index
        if not mask.any():
            zones[definition["key"]] = []
            continue
        polygons = mask_to_polygons(
            mask,
            transform,
            crs,
            min_area_ha=minimum,
            properties={
                "class_key": definition["key"],
                "label": definition["label"],
                "colour": definition["colour"],
                "severity": definition["severity"],
            },
        )
        zones[definition["key"]] = polygons[:max_zones_per_class]
    return {
        "zones": zones,
        "min_area_ha": minimum,
        "zone_count": {key: len(value) for key, value in zones.items()},
        "total_zones": sum(len(value) for value in zones.values()),
    }


def detect_weak_vegetation(
    ndvi: np.ndarray,
    transform: Any,
    crs: Any,
    thresholds: Mapping[str, float] | None = None,
    valid: np.ndarray | None = None,
    weak_threshold: float | None = None,
    min_area_ha: float | None = None,
    include_negative: bool = False,
    cleanup: bool = True,
    pixel_area_ha: float | None = None,
) -> Dict[str, Any]:
    """Find contiguous weak-vegetation regions (NDVI below the weak threshold).

    The raw threshold mask is refined with OpenCV morphology (opening, closing,
    hole filling, small-object removal) because a per-pixel NDVI threshold is
    noisy - only patches that survive cleanup are reported as zones.
    """
    values = np.asarray(ndvi, dtype="float32")
    config_thresholds = dict(thresholds or health_thresholds())
    cutoff = float(weak_threshold if weak_threshold is not None else config_thresholds["low"])
    minimum_area = float(min_area_ha if min_area_ha is not None else get_config().get("crop_health", {}).get("min_patch_area_ha", 0.05))

    mask = np.isfinite(values) & (values < cutoff)
    if not include_negative:
        mask &= values >= 0.0
    if valid is not None:
        mask &= np.asarray(valid, dtype=bool)

    raw_pixels = int(mask.sum())
    pixels_per_ha = 1.0 / pixel_area_ha if pixel_area_ha else None
    min_area_pixels = int(max(4, round(minimum_area * pixels_per_ha))) if pixels_per_ha else 12
    cleaned = cv.clean_mask(mask.astype("uint8") * 255, open_kernel=3, close_kernel=5, min_area_pixels=min_area_pixels) if cleanup else {
        "mask": mask.astype("uint8") * 255,
        "steps": [],
        "removed_pixels": 0,
        "coverage_before": float(mask.mean()),
        "coverage_after": float(mask.mean()),
    }
    final_mask = np.asarray(cleaned["mask"]) > 0
    # Polygons need a georeferenced grid; without one the mask statistics are
    # still complete and useful (e.g. a drone tile with no CRS).
    polygons = (
        mask_to_polygons(
            final_mask,
            transform,
            crs,
            min_area_ha=minimum_area,
            properties={"zone": "weak_vegetation"},
        )
        if final_mask.any() and transform is not None and crs is not None
        else []
    )

    return {
        "threshold": cutoff,
        "include_negative_values": include_negative,
        "pixels_raw": raw_pixels,
        "pixels_cleaned": int(final_mask.sum()),
        "percentage": round(float(final_mask.mean() * 100), 4),
        "area_ha": round(float(final_mask.sum() * pixel_area_ha), 4) if pixel_area_ha else None,
        "patch_count": len(polygons),
        "largest_patch_ha": polygons[0]["area_ha"] if polygons else 0.0,
        "patches": polygons,
        "mask": final_mask,
        "raw_mask": mask,
        "morphology": {
            "applied": bool(cleanup),
            "min_area_ha": minimum_area,
            "min_area_pixels": min_area_pixels,
            "removed_pixels": int(cleaned["removed_pixels"]),
            "steps": cleaned["steps"],
        },
    }


def detect_anomalies(
    ndvi: np.ndarray,
    valid: np.ndarray | None = None,
    method: str = "zscore",
    threshold: float = 2.0,
) -> Dict[str, Any]:
    """Flag pixels that deviate from the field's own NDVI distribution."""
    values = np.asarray(ndvi, dtype="float32")
    mask = np.isfinite(values)
    if valid is not None:
        mask &= np.asarray(valid, dtype=bool)
    if not mask.any():
        return {"method": method, "low_mask": np.zeros(values.shape, dtype=bool), "high_mask": np.zeros(values.shape, dtype=bool), "low_pixels": 0, "high_pixels": 0}

    sample = values[mask]
    if method == "iqr":
        q1, q3 = np.percentile(sample, [25, 75])
        spread = q3 - q1
        low_cut, high_cut = q1 - 1.5 * spread, q3 + 1.5 * spread
    elif method == "zscore":
        mean, std = float(sample.mean()), float(sample.std())
        low_cut, high_cut = mean - threshold * std, mean + threshold * std
    else:
        raise DataError(f"Unknown anomaly method '{method}'")

    low_mask = mask & (values < low_cut)
    high_mask = mask & (values > high_cut)
    return {
        "method": method,
        "threshold": threshold,
        "low_cutoff": round(float(low_cut), 4),
        "high_cutoff": round(float(high_cut), 4),
        "low_mask": low_mask,
        "high_mask": high_mask,
        "low_pixels": int(low_mask.sum()),
        "high_pixels": int(high_mask.sum()),
        "low_percentage": round(float(low_mask.sum() / max(1, int(mask.sum())) * 100), 4),
        "high_percentage": round(float(high_mask.sum() / max(1, int(mask.sum())) * 100), 4),
    }


def ndvi_change(before: np.ndarray, after: np.ndarray, valid: np.ndarray | None = None) -> Dict[str, Any]:
    """Per-pixel NDVI difference between two observations (change detection)."""
    first = np.asarray(before, dtype="float32")
    second = np.asarray(after, dtype="float32")
    if first.shape != second.shape:
        raise DataError(f"NDVI rasters must share a shape to compare ({first.shape} vs {second.shape})")
    mask = np.isfinite(first) & np.isfinite(second)
    if valid is not None:
        mask &= np.asarray(valid, dtype=bool)
    delta = np.full(first.shape, np.nan, dtype="float32")
    delta[mask] = (second - first)[mask]
    if not mask.any():
        return {"mean_change": None, "improved_pixels": 0, "degraded_pixels": 0, "delta": delta}
    changes = delta[mask]
    return {
        "mean_change": round(float(changes.mean()), 4),
        "median_change": round(float(np.median(changes)), 4),
        "max_increase": round(float(changes.max()), 4),
        "max_decrease": round(float(changes.min()), 4),
        "improved_pixels": int((changes > 0.05).sum()),
        "stable_pixels": int((np.abs(changes) <= 0.05).sum()),
        "degraded_pixels": int((changes < -0.05).sum()),
        "improved_percentage": round(float((changes > 0.05).mean() * 100), 3),
        "degraded_percentage": round(float((changes < -0.05).mean() * 100), 3),
        "delta": delta,
    }


# --------------------------------------------------------------------------- #
# field summary and interpretation
# --------------------------------------------------------------------------- #
def field_summary(
    *,
    index_name: str,
    statistics: Mapping[str, Any],
    health: Mapping[str, Any],
    weak_vegetation: Mapping[str, Any] | None = None,
    anomalies: Mapping[str, Any] | None = None,
    field_area_ha: float | None = None,
    analysed_area_ha: float | None = None,
    thresholds: Mapping[str, float] | None = None,
) -> Dict[str, Any]:
    """Combine index, health, weak-vegetation and anomaly results."""
    mean = statistics.get("mean")
    health_score = None
    if mean is not None:
        # 0-100 vigour score: map mean index from 0.0-0.9 onto 0-100.
        health_score = round(float(np.clip(mean / 0.9, 0.0, 1.0) * 100), 1)
    return {
        "index": index_name,
        "mean_index": mean,
        "median_index": statistics.get("median"),
        "vigour_score": health_score,
        "dominant_class": health.get("dominant_class"),
        "healthy_pct": health.get("healthy_pct"),
        "weak_pct": health.get("weak_pct"),
        "weak_vegetation_pct": (weak_vegetation or {}).get("percentage"),
        "weak_vegetation_patches": (weak_vegetation or {}).get("patch_count"),
        "low_anomaly_pct": (anomalies or {}).get("low_percentage"),
        "field_area_ha": round(field_area_ha, 4) if field_area_ha else None,
        "analysed_area_ha": round(analysed_area_ha, 4) if analysed_area_ha else None,
        "coverage_pct": health.get("coverage_pct"),
        "thresholds": dict(thresholds or health_thresholds()),
        "class_keys": health_class_keys(),
    }


def interpret(summary: Mapping[str, Any]) -> Dict[str, Any]:
    """Turn a field summary into short, plain-language statements.

    Deliberately conservative: an index measures canopy greenness, so the text
    describes vigour and where to look - never a diagnosis.
    """
    points: List[str] = []
    mean = summary.get("mean_index")
    healthy = summary.get("healthy_pct") or 0.0
    weak = summary.get("weak_pct") or 0.0
    patches = summary.get("weak_vegetation_patches") or 0

    if mean is None:
        verdict = "No usable pixels"
        points.append("No valid pixels were found inside this AOI - check the AOI overlap and nodata handling.")
    else:
        if mean >= 0.6:
            verdict = "Strong canopy vigour"
            points.append(f"Mean {summary.get('index', 'NDVI')} of {mean:.2f} indicates a dense, active canopy across the field.")
        elif mean >= 0.4:
            verdict = "Developing canopy"
            points.append(f"Mean {summary.get('index', 'NDVI')} of {mean:.2f} indicates partial ground cover, typical of an establishing or ripening canopy.")
        elif mean >= 0.2:
            verdict = "Sparse vegetation"
            points.append(f"Mean {summary.get('index', 'NDVI')} of {mean:.2f} indicates sparse vegetation or significant exposed soil.")
        else:
            verdict = "Very little vegetation"
            points.append(f"Mean {summary.get('index', 'NDVI')} of {mean:.2f} indicates mostly bare soil, water or senescent material.")
        points.append(f"{healthy:.1f}% of analysed pixels fall in the healthy classes and {weak:.1f}% in the low classes.")
        if patches:
            largest = summary.get("largest_patch_ha")
            suffix = f" (largest {largest:.2f} ha)" if largest else ""
            points.append(f"{patches} weak-vegetation patch(es) were detected{suffix} - good candidates for field scouting.")
        elif weak > 1:
            points.append("Low-index pixels are scattered rather than grouped into patches, which often points to noise or mixed pixels.")
        else:
            points.append("No meaningful weak-vegetation patches were detected in this observation.")
        if summary.get("low_anomaly_pct"):
            points.append(f"{summary['low_anomaly_pct']:.2f}% of pixels are statistical low outliers relative to the field itself.")
        coverage = summary.get("coverage_pct")
        if coverage is not None and coverage < 80:
            points.append(
                f"Only {coverage:.1f}% of the clipped window is valid data (clouds, nodata or AOI edges), "
                "so treat these numbers as indicative."
            )

    return {
        "verdict": verdict,
        "points": points,
        "confidence": "indicative" if (summary.get("coverage_pct") or 0) < 80 else "good",
        "disclaimer": (
            "Vegetation indices measure canopy greenness and density. Low values indicate reduced vigour; "
            "they are not a diagnosis of a specific disease, pest or nutrient deficiency. "
            "Confirm anomalies with field scouting, tissue sampling or a calibrated model."
        ),
    }


def health_change(before: Mapping[str, Any], after: Mapping[str, Any]) -> Dict[str, Any]:
    """Compare two health statistics blocks (used by the time-series view)."""
    first_mean = before.get("mean_index")
    second_mean = after.get("mean_index")
    delta = None
    change_pct = None
    if first_mean is not None and second_mean is not None:
        delta = round(float(second_mean) - float(first_mean), 4)
        if float(first_mean) != 0:
            change_pct = round((float(second_mean) - float(first_mean)) / abs(float(first_mean)) * 100, 2)
    return {
        "mean_delta": delta,
        "change_pct": change_pct,
        "healthy_pct_delta": round(float((after.get("healthy_pct") or 0) - (before.get("healthy_pct") or 0)), 3),
        "weak_pct_delta": round(float((after.get("weak_pct") or 0) - (before.get("weak_pct") or 0)), 3),
        "direction": None if delta is None else ("improving" if delta > 0.02 else "declining" if delta < -0.02 else "stable"),
    }


def vegetation_share(ndvi: np.ndarray, threshold: float = 0.2) -> float:
    """Share of valid pixels above a vegetation threshold (percent)."""
    values = np.asarray(ndvi, dtype="float32")
    valid = np.isfinite(values)
    if not valid.any():
        return 0.0
    return round(float((values[valid] >= threshold).mean() * 100), 3)


__all__ = [
    "HEALTH_CLASSES",
    "health_class_keys",
    "health_class_boundaries",
    "thresholds_from_config",
    "classify_health",
    "classify_pixel",
    "health_colour_map",
    "health_statistics",
    "health_zones",
    "detect_weak_vegetation",
    "detect_anomalies",
    "ndvi_change",
    "field_summary",
    "interpret",
    "health_change",
    "vegetation_share",
    "safe_divide",
    "index_statistics",
]
