"""Segmentation engine (AI/ML layer).

The initial platform ships with classical segmentation: index thresholding,
OpenCV mask refinement, connected components and contour extraction. That is
enough to map vegetation patches, bare-soil strips and weak zones - and it
works with zero downloads, zero GPU and zero training.

A model registry makes the layer *segmentation-ready*: a future U-Net,
DeepLab, YOLO-seg or custom PyTorch/TorchScript/ONNX model plugs in by adding a
loader function and registering it. Nothing in the API has to change, and no
heavy dependency is imported until such a model is actually requested.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Iterable, List, Mapping, Sequence

import numpy as np

from data import DataError
from geospatial import mask_to_polygons
import opencv as cv

# --------------------------------------------------------------------------- #
# registries
# --------------------------------------------------------------------------- #
#: Classical, dependency-free segmentation strategies (implemented here).
CLASSICAL_METHODS: Dict[str, Dict[str, Any]] = {
    "threshold": {
        "key": "threshold",
        "label": "Index threshold segmentation",
        "description": "Binary mask from a fixed value on a vegetation index or single band.",
        "params": {"threshold": "float, default 0.4", "comparison": "'above' | 'below'", "min_area_ha": "float, default 0.05"},
        "requires_training": False,
    },
    "otsu": {
        "key": "otsu",
        "label": "Otsu segmentation",
        "description": "Automatic threshold chosen from the image histogram (OpenCV Otsu).",
        "params": {"min_area_ha": "float, default 0.05", "invert": "bool, default false"},
        "requires_training": False,
    },
    "multi_threshold": {
        "key": "multi_threshold",
        "label": "Multi-class threshold segmentation",
        "description": "Splits the index into ordered classes (bare soil / sparse / moderate / dense) using configurable edges.",
        "params": {"boundaries": "list[float], default crop-health thresholds", "min_area_ha": "float, default 0.05"},
        "requires_training": False,
    },
    "zones": {
        "key": "zones",
        "label": "Connected-component zones",
        "description": "Connected-component labelling of an existing mask into discrete zones with areas.",
        "params": {"min_area_ha": "float, default 0.05", "connectivity": "4 | 8, default 8"},
        "requires_training": False,
    },
}

#: Model-backed strategies. Not installed by default - each entry documents how
#: to plug a real model in without touching the pipeline.
MODEL_REGISTRY: Dict[str, Dict[str, Any]] = {
    "unet": {
        "key": "unet",
        "task": "segmentation",
        "label": "U-Net (semantic segmentation)",
        "available": False,
        "backend": "torch",
        "input": "4-band or RGB patch, normalised reflectance",
        "loader": "torch.load / torch.jit.load of a trained checkpoint",
        "install_hint": "pip install torch --index-url https://download.pytorch.org/whl/cpu",
        "notes": "Register a loader with register_model('unet', fn) once a trained checkpoint exists.",
    },
    "deeplab": {
        "key": "deeplab",
        "task": "segmentation",
        "label": "DeepLabV3+ (semantic segmentation)",
        "available": False,
        "backend": "torch",
        "input": "RGB or multispectral patch, 3-4 channels",
        "loader": "torchvision.models.segmentation.deeplabv3_resnet50(weights=None)",
        "install_hint": "pip install torch torchvision (CPU wheels are enough)",
        "notes": "Vibes Lite intentionally does not download pretrained weights automatically.",
    },
    "yolo_seg": {
        "key": "yolo_seg",
        "task": "detection+segmentation",
        "label": "YOLO segmentation",
        "available": False,
        "backend": "ultralytics",
        "input": "RGB image / orthomosaic tile",
        "loader": "YOLO('model.pt') instance segmentation",
        "install_hint": "pip install ultralytics (optional, not required by the platform)",
        "notes": "Suited to per-plant or per-weed detection on drone imagery.",
    },
    "torchscript": {
        "key": "torchscript",
        "task": "any",
        "label": "Custom TorchScript / ONNX model",
        "available": False,
        "backend": "torch | onnxruntime",
        "input": "defined by the exported model",
        "loader": "torch.jit.load(path) or onnxruntime.InferenceSession(path)",
        "install_hint": "pip install torch or onnxruntime when a model is available",
        "notes": "Use register_model('torchscript', loader) with your exported artifact.",
    },
}

_model_loaders: Dict[str, Callable[..., Any]] = {}


def register_model(key: str, loader: Callable[..., Any], *, task: str = "segmentation", label: str | None = None) -> Dict[str, Any]:
    """Register a loader for a model-backed segmentation strategy.

    ``loader`` receives keyword arguments (e.g. ``path``, ``device``) and returns
    an object exposing ``predict(image) -> np.ndarray``. Registering does not
    import any heavy dependency; that happens inside the loader.
    """
    if not callable(loader):
        raise DataError("Model loader must be callable")
    _model_loaders[key] = loader
    entry = MODEL_REGISTRY.setdefault(key, {"key": key, "task": task, "label": label or key, "backend": "custom", "notes": ""})
    entry["available"] = True
    entry["registered"] = True
    return entry


def available_methods() -> Dict[str, Any]:
    """Everything the platform can segment with right now, plus what's planned."""
    return {
        "classical": list(CLASSICAL_METHODS.values()),
        "models": [
            {**spec, "registered": key in _model_loaders}
            for key, spec in MODEL_REGISTRY.items()
        ],
        "default": "threshold",
        "note": (
            "Classical methods work out of the box. Model-backed methods appear in the "
            "registry so a trained U-Net / DeepLab / YOLO-seg checkpoint can be added later "
            "without changing the pipeline or the API."
        ),
    }


# --------------------------------------------------------------------------- #
# classical segmentation
# --------------------------------------------------------------------------- #
def threshold_segment(
    array: np.ndarray,
    threshold: float = 0.4,
    comparison: str = "above",
    valid: np.ndarray | None = None,
) -> np.ndarray:
    """Segment an index/band array into a boolean mask by a fixed threshold."""
    values = np.asarray(array, dtype="float32")
    mask = np.isfinite(values)
    if comparison == "above":
        mask &= values >= float(threshold)
    elif comparison == "below":
        mask &= values < float(threshold)
    else:
        raise DataError("comparison must be 'above' or 'below'")
    if valid is not None:
        mask &= np.asarray(valid, dtype=bool)
    return mask


def multi_threshold_segment(
    array: np.ndarray,
    boundaries: Sequence[float] | None = None,
    valid: np.ndarray | None = None,
) -> np.ndarray:
    """Classify an index array into ordered classes (-1 = invalid, 0..n = classes)."""
    from analysis import health_class_boundaries

    values = np.asarray(array, dtype="float32")
    edges = list(boundaries) if boundaries else health_class_boundaries()
    classes = np.digitize(values, edges, right=False).astype("int16")
    invalid = ~np.isfinite(values)
    if valid is not None:
        invalid |= ~np.asarray(valid, dtype=bool)
    classes[invalid] = -1
    return classes


def otsu_segment(array: np.ndarray, invert: bool = False, valid: np.ndarray | None = None) -> Dict[str, Any]:
    """Segment with an automatically chosen threshold (OpenCV Otsu)."""
    values = np.asarray(array, dtype="float32")
    finite = np.isfinite(values)
    if not finite.any():
        return {"mask": np.zeros(values.shape, dtype=bool), "threshold_value": None, "method": "otsu"}
    scaled = cv.to_gray(cv.ensure_uint8(np.where(finite, values, np.nanmin(values))))
    result = cv.otsu_threshold(scaled, invert=invert)
    mask = np.asarray(result["mask"]) > 0
    if valid is not None:
        mask &= np.asarray(valid, dtype=bool)
    return {"mask": mask, "threshold_value": result["threshold_value"], "method": "otsu", "note": "Threshold applies to the 8-bit stretched index."}


def refine_segmentation_mask(mask: np.ndarray, min_area_pixels: int = 32, open_kernel: int = 3, close_kernel: int = 5) -> Dict[str, Any]:
    """Clean a raw segmentation mask with OpenCV morphology."""
    return cv.clean_mask(mask, open_kernel=open_kernel, close_kernel=close_kernel, min_area_pixels=min_area_pixels)


def connected_components(mask: np.ndarray, connectivity: int = 8, min_area_pixels: int = 16) -> Dict[str, Any]:
    """Label connected components of a mask and report per-component metrics."""
    import cv2

    binary = (cv.as_binary_mask(mask) > 0).astype("uint8")
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=connectivity)
    components: List[Dict[str, Any]] = []
    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < int(min_area_pixels):
            continue
        components.append(
            {
                "label": label,
                "area_pixels": area,
                "bounding_box": [int(stats[label, cv2.CC_STAT_LEFT]), int(stats[label, cv2.CC_STAT_TOP]), int(stats[label, cv2.CC_STAT_WIDTH]), int(stats[label, cv2.CC_STAT_HEIGHT])],
                "centroid_pixels": [round(float(centroids[label][0]), 2), round(float(centroids[label][1]), 2)],
            }
        )
    components.sort(key=lambda item: item["area_pixels"], reverse=True)
    return {
        "components": components,
        "component_count": len(components),
        "labelled_regions": int(count - 1),
        "background_pixels": int(binary.size - binary.sum()),
        "mask_pixels": int(binary.sum()),
        "labels": labels,
    }


def extract_segment_contours(mask: np.ndarray, min_area_pixels: int = 16, approx_epsilon: float = 0.0) -> List[Dict[str, Any]]:
    """Contours (with areas) for each segmented region."""
    return cv.detect_contours(mask, min_area_pixels=min_area_pixels, approx_epsilon=approx_epsilon)


def segmentation_statistics(segmentation: np.ndarray, pixel_area_ha: float | None = None) -> Dict[str, Any]:
    """Area statistics for a labelled segmentation raster."""
    data = np.asarray(segmentation)
    valid = data >= 0
    total_valid = int(valid.sum())
    classes: List[Dict[str, Any]] = []
    for value in sorted(int(v) for v in np.unique(data[valid])) if total_valid else []:
        pixels = int((data == value).sum())
        area = pixels * pixel_area_ha if pixel_area_ha else None
        classes.append(
            {
                "class_value": value,
                "pixels": pixels,
                "percentage": round(pixels / total_valid * 100, 3) if total_valid else 0.0,
                "area_ha": round(area, 4) if area is not None else None,
            }
        )
    return {
        "classes": classes,
        "class_count": len(classes),
        "valid_pixels": total_valid,
        "total_pixels": int(data.size),
        "coverage_pct": round(total_valid / data.size * 100, 3) if data.size else 0.0,
    }


# --------------------------------------------------------------------------- #
# unified entry point
# --------------------------------------------------------------------------- #
def run_segmentation(
    array: np.ndarray,
    method: str = "threshold",
    params: Mapping[str, Any] | None = None,
    transform: Any = None,
    crs: Any = None,
    valid: np.ndarray | None = None,
    pixel_area_ha: float | None = None,
    index_name: str = "NDVI",
    min_area_ha: float | None = None,
) -> Dict[str, Any]:
    """Segment an index/band array and (optionally) return geo-referenced polygons.

    ``transform``/``crs`` are what make the output a *geospatial* segmentation:
    when they are provided every segment gets an area in hectares and a WGS84
    centroid, and can be exported as GeoJSON.
    """
    options = dict(params or {})
    minimum_area = float(min_area_ha if min_area_ha is not None else options.get("min_area_ha", 0.05))
    pixels_per_ha = 1.0 / pixel_area_ha if pixel_area_ha else None
    min_area_pixels = int(max(4, round(minimum_area * pixels_per_ha))) if pixels_per_ha else 16
    values = np.asarray(array, dtype="float32")

    if method in CLASSICAL_METHODS:
        if method == "otsu":
            result = otsu_segment(values, invert=bool(options.get("invert", False)), valid=valid)
            base_mask = result["mask"]
            threshold_value = result["threshold_value"]
            class_raster = None
        elif method == "multi_threshold":
            class_raster = multi_threshold_segment(values, boundaries=options.get("boundaries"), valid=valid)
            base_mask = class_raster > 0
            threshold_value = None
            result = {"method": "multi_threshold", "boundaries": list(options.get("boundaries") or [])}
        elif method == "zones":
            base_mask = np.isfinite(values) & (values > 0)
            if valid is not None:
                base_mask &= np.asarray(valid, dtype=bool)
            class_raster = None
            threshold_value = None
            result = {"method": "zones"}
        else:  # threshold
            threshold_value = float(options.get("threshold", 0.4))
            base_mask = threshold_segment(values, threshold=threshold_value, comparison=str(options.get("comparison", "above")), valid=valid)
            class_raster = None
            result = {"method": "threshold", "threshold": threshold_value}
    elif method in MODEL_REGISTRY:
        loader = _model_loaders.get(method)
        if loader is None:
            spec = MODEL_REGISTRY[method]
            raise DataError(
                f"Segmentation model '{method}' is not available in this installation. "
                f"{spec.get('install_hint', '')} {spec.get('notes', '')}".strip()
            )
        prediction = loader(array=values, **options)
        base_mask = np.asarray(prediction.get("mask") if isinstance(prediction, Mapping) else prediction) > 0
        class_raster = np.asarray(prediction.get("classes")) if isinstance(prediction, Mapping) and prediction.get("classes") is not None else None
        threshold_value = None
        result = {"method": method, "model": True}
    else:
        raise DataError(f"Unknown segmentation method '{method}'. Available: {', '.join(list(CLASSICAL_METHODS) + list(MODEL_REGISTRY))}")

    cleaned = refine_segmentation_mask(base_mask, min_area_pixels=min_area_pixels, open_kernel=int(options.get("open_kernel", 3)), close_kernel=int(options.get("close_kernel", 5)))
    final_mask = np.asarray(cleaned["mask"]) > 0
    components = connected_components(final_mask, connectivity=int(options.get("connectivity", 8)), min_area_pixels=min_area_pixels)
    contours = extract_segment_contours(final_mask, min_area_pixels=min_area_pixels, approx_epsilon=float(options.get("approx_epsilon", 0.0)))

    payload: Dict[str, Any] = {
        **result,
        "index": index_name,
        "mask": final_mask,
        "raw_mask": base_mask,
        "class_raster": class_raster,
        "mask_coverage_pct": round(float(final_mask.mean() * 100), 4),
        "mask_pixels": int(final_mask.sum()),
        "total_pixels": int(final_mask.size),
        "component_count": components["component_count"],
        "components": components["components"][:100],
        "contour_count": len(contours),
        "contours": contours[:100],
        "morphology": {"min_area_ha": minimum_area, "min_area_pixels": min_area_pixels, "removed_pixels": int(cleaned["removed_pixels"]), "steps": cleaned["steps"]},
        "statistics": segmentation_statistics(class_raster if class_raster is not None else final_mask.astype("int16"), pixel_area_ha=pixel_area_ha),
        "provider": "classical" if method in CLASSICAL_METHODS else "model",
    }
    payload["area_ha"] = round(float(final_mask.sum() * pixel_area_ha), 4) if pixel_area_ha else None

    if transform is not None and crs is not None:
        payload["segments_geojson"] = segments_feature_collection(final_mask, transform, crs, minimum_area, properties={"class": "vegetation"})
        payload["segments"] = mask_to_polygons(final_mask, transform, crs, min_area_ha=minimum_area, properties={"class": "vegetation"})[:50]
    else:
        payload["segments_geojson"] = None
        payload["segments"] = []
    return payload


def segments_feature_collection(mask: np.ndarray, transform: Any, crs: Any, min_area_ha: float = 0.0, properties: Mapping[str, Any] | None = None) -> Dict[str, Any]:
    """Segmented mask as a GeoJSON FeatureCollection (map-ready)."""
    polygons = mask_to_polygons(mask, transform, crs, min_area_ha=min_area_ha, properties=dict(properties or {}))
    features = [
        {"type": "Feature", "geometry": record["geometry_geojson"], "properties": {k: v for k, v in record.items() if k != "geometry_geojson"}}
        for record in polygons
    ]
    return {"type": "FeatureCollection", "features": features, "properties": {"source": "vibes-lite segmentation", "segment_count": len(features)}}


def summarise_segments(segments: Iterable[Mapping[str, Any]], top: int = 5) -> List[Dict[str, Any]]:
    """Largest segments, trimmed for API responses."""
    ordered = sorted(segments, key=lambda item: item.get("area_ha") or 0, reverse=True)
    return [
        {
            "area_ha": item.get("area_ha"),
            "centroid_lonlat": item.get("centroid_lonlat"),
            "class": item.get("class") or item.get("class_key"),
            "label": item.get("label"),
        }
        for item in ordered[:top]
    ]
