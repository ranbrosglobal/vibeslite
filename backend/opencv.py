"""OpenCV computer-vision engine.

OpenCV is a core component of Vibes Lite: it cleans imagery, builds and refines
masks, extracts contours and produces annotated previews. Everything here is
independent of FastAPI - the API layer only calls ``process_image`` and the
mask/contour helpers, so the same functions can be used from notebooks or from
future model-preprocessing steps.

Colour convention: OpenCV expects BGR. Helper functions in this module accept
either a grayscale 2D array or a 3D array in **RGB** order and convert
internally, so callers never have to think about channel order.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Sequence

import cv2
import numpy as np

from config import get_config
from data import DataError

# --------------------------------------------------------------------------- #
# conversion / io
# --------------------------------------------------------------------------- #
def ensure_uint8(image: np.ndarray) -> np.ndarray:
    """Return a uint8 copy of an image, rescaling float input if needed."""
    data = np.asarray(image)
    if data.dtype == np.uint8:
        return data.copy()
    finite = np.isfinite(data)
    if not finite.any():
        return np.zeros(data.shape, dtype="uint8")
    low, high = np.nanmin(data[finite]), np.nanmax(data[finite])
    if high <= low:
        return np.zeros(data.shape, dtype="uint8")
    scaled = (np.nan_to_num(data, nan=low) - low) / (high - low)
    return (np.clip(scaled, 0, 1) * 255).astype("uint8")


def to_gray(image: np.ndarray) -> np.ndarray:
    """Convert RGB/gray input to a single-channel uint8 image."""
    data = ensure_uint8(image)
    if data.ndim == 2:
        return data
    if data.shape[2] == 1:
        return data[:, :, 0]
    if data.shape[2] == 3:
        return cv2.cvtColor(data, cv2.COLOR_RGB2GRAY)
    if data.shape[2] == 4:
        return cv2.cvtColor(data, cv2.COLOR_RGBA2GRAY)
    raise DataError(f"Unsupported channel count: {data.shape[2]}")


def load_image(path: str | Path) -> np.ndarray:
    """Read an image from disk as an RGB array (grayscale stays 2D)."""
    file_path = Path(path)
    if not file_path.exists():
        raise DataError(f"Image '{file_path.name}' not found")
    data = cv2.imread(str(file_path), cv2.IMREAD_UNCHANGED)
    if data is None:
        raise DataError(f"OpenCV could not decode '{file_path.name}'")
    if data.ndim == 3 and data.shape[2] == 3:
        data = cv2.cvtColor(data, cv2.COLOR_BGR2RGB)
    elif data.ndim == 3 and data.shape[2] == 4:
        data = cv2.cvtColor(data, cv2.COLOR_BGRA2RGBA)
    return data


def save_image(path: str | Path, image: np.ndarray) -> Path:
    """Write an RGB/gray image to disk (BGR conversion handled here)."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    data = ensure_uint8(image)
    if data.ndim == 3 and data.shape[2] == 3:
        data = cv2.cvtColor(data, cv2.COLOR_RGB2BGR)
    if not cv2.imwrite(str(target), data):
        raise DataError(f"Could not write image to '{target.name}'")
    return target


# --------------------------------------------------------------------------- #
# basic operations
# --------------------------------------------------------------------------- #
def resize_image(image: np.ndarray, width: int | None = None, height: int | None = None, scale: float | None = None, interpolation: str = "linear") -> np.ndarray:
    """Resize keeping aspect ratio when only one dimension is provided."""
    data = np.asarray(image)
    h, w = data.shape[:2]
    if scale:
        new_w, new_h = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    elif width and height:
        new_w, new_h = int(width), int(height)
    elif width:
        new_w, new_h = int(width), max(1, int(round(h * width / w)))
    elif height:
        new_h, new_w = int(height), max(1, int(round(w * height / h)))
    else:
        return data.copy()
    method = {
        "nearest": cv2.INTER_NEAREST,
        "linear": cv2.INTER_LINEAR,
        "cubic": cv2.INTER_CUBIC,
        "area": cv2.INTER_AREA,
        "lanczos": cv2.INTER_LANCZOS4,
    }.get(interpolation, cv2.INTER_LINEAR)
    return cv2.resize(data, (new_w, new_h), interpolation=method)


def denoise(image: np.ndarray, strength: int | None = None, method: str = "nlm") -> np.ndarray:
    """Denoise colour or grayscale imagery (non-local means or bilateral)."""
    config = get_config().get("opencv", {})
    if method == "bilateral":
        kwargs = dict(d=9, sigmaColor=75, sigmaSpace=75)
        return cv2.bilateralFilter(ensure_uint8(image), **kwargs)
    h_value = int(strength if strength is not None else config.get("denoise_h", 7))
    data = ensure_uint8(image)
    if data.ndim == 2:
        return cv2.fastNlMeansDenoising(data, None, h_value, 7, 21)
    return cv2.fastNlMeansDenoisingColored(data, None, h_value, h_value, 7, 21)


def gaussian_blur(image: np.ndarray, kernel: int | None = None, sigma: float = 0.0) -> np.ndarray:
    """Gaussian smoothing with an odd kernel size."""
    config = get_config().get("opencv", {})
    size = int(kernel if kernel is not None else config.get("gaussian_kernel", 5))
    size = max(1, size)
    if size % 2 == 0:
        size += 1
    return cv2.GaussianBlur(ensure_uint8(image), (size, size), sigma)


def median_blur(image: np.ndarray, kernel: int = 5) -> np.ndarray:
    size = max(1, int(kernel))
    if size % 2 == 0:
        size += 1
    return cv2.medianBlur(ensure_uint8(image), size)


def enhance_image(image: np.ndarray, method: str = "clahe", clip_limit: float = 2.5, tile_grid: int = 8, gamma: float = 1.1, strength: float = 1.4) -> np.ndarray:
    """Contrast / sharpness enhancement (CLAHE, gamma or unsharp masking)."""
    data = ensure_uint8(image)
    if method == "clahe":
        clahe = cv2.createCLAHE(clipLimit=float(clip_limit), tileGridSize=(int(tile_grid), int(tile_grid)))
        if data.ndim == 2:
            return clahe.apply(data)
        lab = cv2.cvtColor(data, cv2.COLOR_RGB2LAB)
        lightness, a_channel, b_channel = cv2.split(lab)
        merged = cv2.merge([clahe.apply(lightness), a_channel, b_channel])
        return cv2.cvtColor(merged, cv2.COLOR_LAB2RGB)
    if method == "gamma":
        inverse = 1.0 / max(0.01, float(gamma))
        table = (np.power(np.arange(256) / 255.0, inverse) * 255).astype("uint8")
        return cv2.LUT(data, table)
    if method == "sharpen":
        blurred = cv2.GaussianBlur(data, (0, 0), 3)
        return cv2.addWeighted(data, float(strength), blurred, -(float(strength) - 1.0), 0)
    raise DataError(f"Unknown enhancement method '{method}'")


# --------------------------------------------------------------------------- #
# thresholding
# --------------------------------------------------------------------------- #
def threshold(image: np.ndarray, value: int = 127, invert: bool = False, max_value: int = 255) -> np.ndarray:
    """Global binary threshold on a grayscale image."""
    gray = to_gray(image)
    kind = cv2.THRESH_BINARY_INV if invert else cv2.THRESH_BINARY
    _, result = cv2.threshold(gray, int(value), max_value, kind)
    return result


def otsu_threshold(image: np.ndarray, invert: bool = False) -> Dict[str, Any]:
    """Automatic (Otsu) threshold; returns the mask and the chosen value."""
    gray = to_gray(image)
    kind = cv2.THRESH_BINARY_INV if invert else cv2.THRESH_BINARY
    value, result = cv2.threshold(gray, 0, 255, kind + cv2.THRESH_OTSU)
    return {"mask": result, "threshold_value": float(value), "method": "otsu"}


def adaptive_threshold(image: np.ndarray, block_size: int = 35, constant: int = 5, invert: bool = False) -> np.ndarray:
    """Adaptive (local mean) threshold, robust to uneven illumination."""
    gray = to_gray(image)
    block = max(3, int(block_size) | 1)
    kind = cv2.THRESH_BINARY_INV if invert else cv2.THRESH_BINARY
    return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, kind, block, int(constant))


def threshold_mask(image: np.ndarray, min_value: float | None = None, max_value: float | None = None) -> np.ndarray:
    """Range threshold producing a boolean mask (used by the NDVI pipeline)."""
    data = np.asarray(image, dtype="float32")
    mask = np.isfinite(data)
    if min_value is not None:
        mask &= data >= float(min_value)
    if max_value is not None:
        mask &= data <= float(max_value)
    return mask


# --------------------------------------------------------------------------- #
# morphology / mask cleanup
# --------------------------------------------------------------------------- #
def _kernel(kernel_size: int) -> np.ndarray:
    size = max(1, int(kernel_size))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))


def as_binary_mask(mask: np.ndarray) -> np.ndarray:
    """Normalise any mask-like input to a 0/255 uint8 single-channel image."""
    data = np.asarray(mask)
    if data.ndim == 3:
        data = to_gray(data)
    if data.dtype == bool:
        return (data.astype("uint8") * 255)
    if data.dtype != np.uint8:
        data = (data > 0).astype("uint8") * 255 if np.nanmax(data) <= 1 else ensure_uint8(data)
    return data


def erode(mask: np.ndarray, kernel_size: int = 3, iterations: int = 1) -> np.ndarray:
    return cv2.erode(as_binary_mask(mask), _kernel(kernel_size), iterations=max(1, int(iterations)))


def dilate(mask: np.ndarray, kernel_size: int = 3, iterations: int = 1) -> np.ndarray:
    return cv2.dilate(as_binary_mask(mask), _kernel(kernel_size), iterations=max(1, int(iterations)))


def morph_open(mask: np.ndarray, kernel_size: int = 3, iterations: int = 1) -> np.ndarray:
    """Opening: removes small bright specks (salt noise) from a mask."""
    return cv2.morphologyEx(as_binary_mask(mask), cv2.MORPH_OPEN, _kernel(kernel_size), iterations=max(1, int(iterations)))


def morph_close(mask: np.ndarray, kernel_size: int = 3, iterations: int = 1) -> np.ndarray:
    """Closing: fills small holes and connects nearby regions."""
    return cv2.morphologyEx(as_binary_mask(mask), cv2.MORPH_CLOSE, _kernel(kernel_size), iterations=max(1, int(iterations)))


def morph_gradient(mask: np.ndarray, kernel_size: int = 3) -> np.ndarray:
    """Morphological gradient: outlines regions (used for boundary emphasis)."""
    return cv2.morphologyEx(as_binary_mask(mask), cv2.MORPH_GRADIENT, _kernel(kernel_size))


def remove_small_objects(mask: np.ndarray, min_area_pixels: int = 32, connectivity: int = 8) -> np.ndarray:
    """Drop connected components smaller than ``min_area_pixels``."""
    binary = as_binary_mask(mask)
    count, labels, stats, _ = cv2.connectedComponentsWithStats((binary > 0).astype("uint8"), connectivity=connectivity)
    cleaned = np.zeros_like(binary)
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] >= int(min_area_pixels):
            cleaned[labels == label] = 255
    return cleaned


def clean_mask(
    mask: np.ndarray,
    open_kernel: int = 3,
    close_kernel: int = 5,
    min_area_pixels: int = 32,
    fill_holes: bool = True,
) -> Dict[str, Any]:
    """Standard mask refinement: open, close, fill holes, drop small blobs."""
    original = as_binary_mask(mask)
    steps: List[Dict[str, Any]] = []
    result = original
    if open_kernel > 1:
        result = morph_open(result, open_kernel)
        steps.append({"operation": "morph_open", "kernel": open_kernel})
    if close_kernel > 1:
        result = morph_close(result, close_kernel)
        steps.append({"operation": "morph_close", "kernel": close_kernel})
    if fill_holes:
        filled = result.copy()
        contours, _ = cv2.findContours(result, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(filled, contours, -1, 255, thickness=cv2.FILLED)
        result = filled
        steps.append({"operation": "fill_holes"})
    if min_area_pixels > 1:
        result = remove_small_objects(result, min_area_pixels)
        steps.append({"operation": "remove_small_objects", "min_area_pixels": min_area_pixels})
    return {
        "mask": result,
        "steps": steps,
        "removed_pixels": int((original > 0).sum() - (result > 0).sum()),
        "coverage_before": round(float((original > 0).mean()), 5),
        "coverage_after": round(float((result > 0).mean()), 5),
    }


def create_mask(image: np.ndarray, method: str = "otsu", value: int = 127, block_size: int = 35, constant: int = 5, invert: bool = False, min_value: float | None = None, max_value: float | None = None) -> Dict[str, Any]:
    """Build a binary mask from an image using a named method."""
    if method == "otsu":
        result = otsu_threshold(image, invert=invert)
        return {"mask": result["mask"], "method": "otsu", "threshold_value": result["threshold_value"]}
    if method == "global":
        return {"mask": threshold(image, value=value, invert=invert), "method": "global", "threshold_value": float(value)}
    if method == "adaptive":
        return {"mask": adaptive_threshold(image, block_size=block_size, constant=constant, invert=invert), "method": "adaptive"}
    if method == "range":
        return {"mask": (as_binary_mask(threshold_mask(image, min_value, max_value))), "method": "range", "min": min_value, "max": max_value}
    raise DataError(f"Unknown mask method '{method}'")


# --------------------------------------------------------------------------- #
# edges / contours / ROI
# --------------------------------------------------------------------------- #
def edge_detect(image: np.ndarray, method: str = "canny", low: int | None = None, high: int | None = None, kernel_size: int = 3) -> np.ndarray:
    """Edge detection: canny, sobel, laplacian or scharr."""
    config = get_config().get("opencv", {})
    gray = gaussian_blur(to_gray(image), kernel=5)
    if method == "canny":
        low_threshold = int(low if low is not None else config.get("canny_low", 50))
        high_threshold = int(high if high is not None else config.get("canny_high", 150))
        return cv2.Canny(gray, low_threshold, high_threshold)
    if method == "sobel":
        grad_x = cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=int(kernel_size))
        grad_y = cv2.Sobel(gray, cv2.CV_16S, 0, 1, ksize=int(kernel_size))
        magnitude = cv2.convertScaleAbs(cv2.magnitude(grad_x.astype("float32"), grad_y.astype("float32")))
        return magnitude
    if method == "laplacian":
        return cv2.convertScaleAbs(cv2.Laplacian(gray, cv2.CV_16S, ksize=int(kernel_size)))
    if method == "scharr":
        grad_x = cv2.Scharr(gray, cv2.CV_16S, 1, 0)
        grad_y = cv2.Scharr(gray, cv2.CV_16S, 0, 1)
        return cv2.convertScaleAbs(cv2.magnitude(grad_x.astype("float32"), grad_y.astype("float32")))
    raise DataError(f"Unknown edge detection method '{method}'")


def detect_contours(mask: np.ndarray, mode: str = "external", min_area_pixels: int = 16, approx_epsilon: float = 0.0) -> List[Dict[str, Any]]:
    """Extract contours (and useful metrics) from a binary mask."""
    binary = as_binary_mask(mask)
    retrieval = {"external": cv2.RETR_EXTERNAL, "list": cv2.RETR_LIST, "tree": cv2.RETR_TREE}.get(mode, cv2.RETR_EXTERNAL)
    contours, hierarchy = cv2.findContours(binary, retrieval, cv2.CHAIN_APPROX_SIMPLE)
    records: List[Dict[str, Any]] = []
    for index, contour in enumerate(contours):
        area = float(cv2.contourArea(contour))
        if area < min_area_pixels:
            continue
        simplified = cv2.approxPolyDP(contour, float(approx_epsilon), True) if approx_epsilon else contour
        x, y, w, h = cv2.boundingRect(contour)
        moments = cv2.moments(contour)
        if moments["m00"]:
            centre = [float(moments["m10"] / moments["m00"]), float(moments["m01"] / moments["m00"])]
        else:
            centre = [float(x + w / 2), float(y + h / 2)]
        records.append(
            {
                "index": index,
                "area_pixels": round(area, 2),
                "perimeter_pixels": round(float(cv2.arcLength(contour, True)), 2),
                "bounding_box": [int(x), int(y), int(w), int(h)],
                "centroid_pixels": [round(centre[0], 2), round(centre[1], 2)],
                "vertices": int(len(simplified)),
                "points": [[int(p[0][0]), int(p[0][1])] for p in simplified],
            }
        )
    records.sort(key=lambda item: item["area_pixels"], reverse=True)
    return records


def count_contours(mask: np.ndarray, min_area_pixels: int = 16) -> int:
    return len(detect_contours(mask, min_area_pixels=min_area_pixels))


def extract_roi(image: np.ndarray, x: int, y: int, width: int, height: int) -> np.ndarray:
    """Crop a region of interest, clamped to the image bounds."""
    data = np.asarray(image)
    image_height, image_width = data.shape[:2]
    x0, y0 = max(0, int(x)), max(0, int(y))
    x1, y1 = min(image_width, x0 + max(1, int(width))), min(image_height, y0 + max(1, int(height)))
    if x1 <= x0 or y1 <= y0:
        raise DataError("ROI is outside the image bounds")
    return data[y0:y1, x0:x1].copy()


def crop_to_mask(image: np.ndarray, mask: np.ndarray, padding: int = 0) -> np.ndarray:
    """Crop an image to the bounding box of its mask."""
    binary = as_binary_mask(mask) > 0
    rows = np.where(binary.any(axis=1))[0]
    columns = np.where(binary.any(axis=0))[0]
    if rows.size == 0 or columns.size == 0:
        raise DataError("Mask is empty: nothing to crop")
    pad = max(0, int(padding))
    return extract_roi(
        image,
        columns[0] - pad,
        rows[0] - pad,
        (columns[-1] - columns[0]) + 1 + 2 * pad,
        (rows[-1] - rows[0]) + 1 + 2 * pad,
    )


# --------------------------------------------------------------------------- #
# overlays
# --------------------------------------------------------------------------- #
def create_overlay(
    image: np.ndarray,
    mask: np.ndarray | None = None,
    contours: Sequence[Mapping[str, Any]] | None = None,
    colour: tuple[int, int, int] = (255, 214, 10),
    alpha: float = 0.45,
    thickness: int = 2,
    label: str | None = None,
) -> np.ndarray:
    """Blend a highlight mask and/or draw contours on an RGB image."""
    base = ensure_uint8(image)
    if base.ndim == 2:
        base = cv2.cvtColor(base, cv2.COLOR_GRAY2RGB)
    elif base.shape[2] == 4:
        base = cv2.cvtColor(base, cv2.COLOR_RGBA2RGB)
    overlay = base.copy()
    if mask is not None:
        binary = as_binary_mask(mask) > 0
        if binary.any():
            tint = np.zeros_like(overlay)
            tint[:] = np.array(colour, dtype="uint8")
            blended = cv2.addWeighted(overlay, 1.0 - float(alpha), tint, float(alpha), 0)
            overlay[binary] = blended[binary]
    if contours:
        for record in contours:
            points = np.asarray(record.get("points") or [], dtype="int32")
            if points.size == 0:
                continue
            cv2.polylines(overlay, [points.reshape(-1, 1, 2)], True, tuple(int(c) for c in colour), max(1, int(thickness)))
    if label:
        cv2.putText(overlay, label, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 4, cv2.LINE_AA)
        cv2.putText(overlay, label, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, tuple(int(c) for c in colour), 1, cv2.LINE_AA)
    return overlay


def annotate_contours(image: np.ndarray, contours: Sequence[Mapping[str, Any]], colour: tuple[int, int, int] = (255, 214, 10), thickness: int = 2, label_areas: bool = True) -> np.ndarray:
    """Draw detected contours (and optionally their area) on an image."""
    base = ensure_uint8(image)
    if base.ndim == 2:
        base = cv2.cvtColor(base, cv2.COLOR_GRAY2RGB)
    annotated = base.copy()
    for record in contours:
        points = np.asarray(record.get("points") or [], dtype="int32")
        if points.size == 0:
            continue
        cv2.polylines(annotated, [points.reshape(-1, 1, 2)], True, tuple(int(c) for c in colour), max(1, int(thickness)))
        if label_areas:
            x, y, _, _ = record.get("bounding_box", [0, 0, 0, 0])
            cv2.putText(annotated, f"{record.get('area_pixels', 0):.0f}px", (int(x), max(12, int(y) - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 2, cv2.LINE_AA)
    return annotated


def side_by_side(before: np.ndarray, after: np.ndarray, gap: int = 8, background: int = 20) -> np.ndarray:
    """Stack two images horizontally (for a before/after preview)."""
    left, right = to_display(before), to_display(after)
    height = max(left.shape[0], right.shape[0])
    width = left.shape[1] + right.shape[1] + int(gap)
    canvas = np.full((height, width, 3), background, dtype="uint8")
    canvas[: left.shape[0], : left.shape[1]] = left
    canvas[: right.shape[0], left.shape[1] + int(gap) : left.shape[1] + int(gap) + right.shape[1]] = right
    return canvas


def to_display(image: np.ndarray) -> np.ndarray:
    """3-channel uint8 view of any image for compositing."""
    data = ensure_uint8(image)
    if data.ndim == 2:
        return cv2.cvtColor(data, cv2.COLOR_GRAY2RGB)
    if data.shape[2] == 4:
        return cv2.cvtColor(data, cv2.COLOR_RGBA2RGB)
    return data


def encode_png(image: np.ndarray) -> bytes:
    """PNG bytes for an RGB/gray image (used for API responses)."""
    data = to_display(image)
    success, buffer = cv2.imencode(".png", cv2.cvtColor(data, cv2.COLOR_RGB2BGR))
    if not success:
        raise DataError("Could not encode PNG")
    return buffer.tobytes()


def image_statistics(image: np.ndarray) -> Dict[str, Any]:
    """Basic brightness/contrast/edge statistics for before/after comparison."""
    display = to_display(image)
    gray = to_gray(image)
    return {
        "shape": [int(v) for v in display.shape[:2]],
        "mean_brightness": round(float(gray.mean()), 3),
        "std_contrast": round(float(gray.std()), 3),
        "min": int(gray.min()),
        "max": int(gray.max()),
        "edge_density": round(float((cv2.Canny(gray, 50, 150) > 0).mean()), 5),
    }


# --------------------------------------------------------------------------- #
# pipeline
# --------------------------------------------------------------------------- #
def _operations() -> Dict[str, Callable[..., np.ndarray]]:
    """Named operations available to ``process_image`` (single source of truth)."""
    return {
        "grayscale": lambda image, params: to_gray(image),
        "resize": lambda image, params: resize_image(image, scale=params.get("scale"), width=params.get("width"), height=params.get("height"), interpolation=params.get("interpolation", "linear")),
        "denoise": lambda image, params: denoise(image, strength=params.get("strength"), method=params.get("method", "nlm")),
        "blur": lambda image, params: gaussian_blur(image, kernel=params.get("kernel"), sigma=float(params.get("sigma", 0.0))),
        "median_blur": lambda image, params: median_blur(image, kernel=int(params.get("kernel", 5))),
        "enhance": lambda image, params: enhance_image(image, method=params.get("method", "clahe"), clip_limit=float(params.get("clip_limit", 2.5)), gamma=float(params.get("gamma", 1.1))),
        "threshold": lambda image, params: threshold(image, value=int(params.get("value", 127)), invert=bool(params.get("invert", False))),
        "otsu": lambda image, params: otsu_threshold(image, invert=bool(params.get("invert", False)))["mask"],
        "adaptive_threshold": lambda image, params: adaptive_threshold(image, block_size=int(params.get("block_size", 35)), constant=int(params.get("constant", 5)), invert=bool(params.get("invert", False))),
        "erode": lambda image, params: erode(image, kernel_size=int(params.get("kernel", 3)), iterations=int(params.get("iterations", 1))),
        "dilate": lambda image, params: dilate(image, kernel_size=int(params.get("kernel", 3)), iterations=int(params.get("iterations", 1))),
        "morph_open": lambda image, params: morph_open(image, kernel_size=int(params.get("kernel", 3))),
        "morph_close": lambda image, params: morph_close(image, kernel_size=int(params.get("kernel", 5))),
        "morph_gradient": lambda image, params: morph_gradient(image, kernel_size=int(params.get("kernel", 3))),
        "clean_mask": lambda image, params: clean_mask(image, open_kernel=int(params.get("open_kernel", 3)), close_kernel=int(params.get("close_kernel", 5)), min_area_pixels=int(params.get("min_area_pixels", 32)))["mask"],
        "remove_small_objects": lambda image, params: remove_small_objects(image, min_area_pixels=int(params.get("min_area_pixels", 32))),
        "edges": lambda image, params: edge_detect(image, method=params.get("method", "canny"), low=params.get("low"), high=params.get("high")),
        "invert": lambda image, params: cv2.bitwise_not(as_binary_mask(image)),
    }


def available_operations() -> List[str]:
    """All operations usable in ``process_image`` (surfaced by the API)."""
    return sorted(_operations().keys())


def process_image(
    image: np.ndarray,
    operations: Iterable[Any] | None = None,
    detect_contours_flag: bool = True,
    min_contour_area: int = 16,
) -> Dict[str, Any]:
    """Run a pipeline of OpenCV operations over an image.

    ``operations`` accepts either operation names or ``{"name": ..., "params": {...}}``
    mappings, so the API can pass user input straight through.
    """
    registry = _operations()
    steps: List[Dict[str, Any]] = []
    current = np.asarray(image)
    if current.ndim == 3 and current.shape[2] == 4:
        current = cv2.cvtColor(ensure_uint8(current), cv2.COLOR_RGBA2RGB)

    for entry in operations or []:
        if isinstance(entry, str):
            name, params = entry, {}
        elif isinstance(entry, Mapping):
            name, params = str(entry.get("name", "")), dict(entry.get("params") or {})
        else:
            raise DataError(f"Unsupported operation entry: {entry!r}")
        if name not in registry:
            raise DataError(f"Unknown operation '{name}'. Available: {', '.join(sorted(registry))}")
        started = time.perf_counter()
        current = registry[name](current, params)
        steps.append(
            {
                "operation": name,
                "params": params,
                "output_shape": [int(v) for v in current.shape],
                "output_dtype": str(current.dtype),
                "duration_ms": round((time.perf_counter() - started) * 1000, 2),
            }
        )

    result: Dict[str, Any] = {
        "image": current,
        "steps": steps,
        "operation_count": len(steps),
        "output_shape": [int(v) for v in current.shape],
        "output_dtype": str(current.dtype),
        "binary": bool(
            np.asarray(current).dtype == np.uint8
            and np.isin(np.unique(np.asarray(current)), [0, 255]).all()
        ),
    }
    if detect_contours_flag and result["binary"]:
        contours = detect_contours(current, min_area_pixels=min_contour_area)
        result["contours"] = contours
        result["contour_count"] = len(contours)
        result["total_contour_area_pixels"] = round(sum(c["area_pixels"] for c in contours), 2)
    else:
        result["contours"] = []
        result["contour_count"] = 0
        result["total_contour_area_pixels"] = 0.0
    return result


def mask_coverage(mask: np.ndarray) -> float:
    """Fraction of the image covered by a mask."""
    binary = as_binary_mask(mask) > 0
    return round(float(binary.mean()), 5)
