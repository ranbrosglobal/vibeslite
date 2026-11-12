"""OpenCV engine tests."""
from __future__ import annotations

import numpy as np
import pytest

import opencv as cv
from data import DataError


@pytest.fixture()
def binary_image() -> np.ndarray:
    """Two rectangles on a dark background (clear, countable contours)."""
    image = np.zeros((100, 120), dtype="uint8")
    image[10:30, 10:40] = 255
    image[50:80, 60:110] = 255
    return image


@pytest.fixture()
def noisy_gray() -> np.ndarray:
    rng = np.random.default_rng(11)
    base = np.full((80, 80), 120, dtype="uint8")
    base[20:60, 20:60] = 200
    noise = rng.integers(-25, 25, base.shape)
    return np.clip(base.astype("int16") + noise, 0, 255).astype("uint8")


def test_to_gray_and_ensure_uint8():
    rgb = np.dstack([np.full((10, 10), 200, "uint8"), np.full((10, 10), 100, "uint8"), np.zeros((10, 10), "uint8")])
    gray = cv.to_gray(rgb)
    assert gray.shape == (10, 10)
    assert gray.dtype == np.uint8
    float_input = np.linspace(0, 1, 100, dtype="float32").reshape(10, 10)
    assert cv.ensure_uint8(float_input).max() == 255


def test_resize_image_keeps_aspect_ratio():
    image = np.zeros((100, 200, 3), dtype="uint8")
    resized = cv.resize_image(image, width=100)
    assert resized.shape[:2] == (50, 100)
    assert cv.resize_image(image, scale=0.5).shape[:2] == (50, 100)
    assert cv.resize_image(image, height=50).shape[:2] == (50, 100)


def test_denoise_blur_and_enhance_preserve_shape(noisy_gray):
    for result in (
        cv.denoise(noisy_gray),
        cv.gaussian_blur(noisy_gray, kernel=5),
        cv.median_blur(noisy_gray, kernel=5),
        cv.enhance_image(noisy_gray, method="clahe"),
        cv.enhance_image(noisy_gray, method="gamma"),
        cv.enhance_image(noisy_gray, method="sharpen"),
    ):
        assert result.shape == noisy_gray.shape
        assert result.dtype == np.uint8
    assert cv.denoise(noisy_gray).std() < noisy_gray.std()
    with pytest.raises(DataError):
        cv.enhance_image(noisy_gray, method="unknown")


def test_threshold_variants(noisy_gray):
    global_mask = cv.threshold(noisy_gray, value=150)
    assert set(np.unique(global_mask)) <= {0, 255}
    otsu = cv.otsu_threshold(noisy_gray)
    assert 0 <= otsu["threshold_value"] <= 255
    adaptive = cv.adaptive_threshold(noisy_gray)
    assert adaptive.shape == noisy_gray.shape
    range_mask = cv.threshold_mask(noisy_gray, min_value=150, max_value=255)
    assert range_mask.dtype == bool
    assert range_mask.sum() > 0


def test_create_mask_methods(noisy_gray):
    for method in ("otsu", "global", "adaptive", "range"):
        result = cv.create_mask(noisy_gray, method=method, min_value=100, max_value=255)
        assert result["mask"].shape == noisy_gray.shape
        assert result["method"] == method
    with pytest.raises(DataError):
        cv.create_mask(noisy_gray, method="nope")


def test_morphology_operations(binary_image):
    eroded = cv.erode(binary_image, kernel_size=3)
    dilated = cv.dilate(binary_image, kernel_size=3)
    assert eroded.sum() < binary_image.sum()
    assert dilated.sum() > binary_image.sum()
    opened = cv.morph_open(binary_image, kernel_size=3)
    closed = cv.morph_close(binary_image, kernel_size=3)
    assert opened.sum() <= binary_image.sum()
    assert closed.sum() >= binary_image.sum()
    gradient = cv.morph_gradient(binary_image, kernel_size=3)
    assert gradient.max() == 255


def test_clean_mask_removes_specks_and_fills_holes():
    mask = np.zeros((60, 60), dtype="uint8")
    mask[10:40, 10:40] = 255
    mask[25, 25] = 0  # hole
    mask[55, 55] = 255  # speck
    result = cv.clean_mask(mask, open_kernel=3, close_kernel=5, min_area_pixels=20)
    cleaned = result["mask"]
    assert cleaned[25, 25] == 255  # hole filled
    assert cleaned[55, 55] == 0  # speck removed
    assert result["removed_pixels"] >= 1
    assert [step["operation"] for step in result["steps"]][0] == "morph_open"
    assert result["coverage_after"] < result["coverage_before"]


def test_remove_small_objects_keeps_large_components():
    mask = np.zeros((50, 50), dtype="uint8")
    mask[5:25, 5:25] = 255
    mask[45, 45] = 255
    cleaned = cv.remove_small_objects(mask, min_area_pixels=10)
    assert cleaned[10, 10] == 255
    assert cleaned[45, 45] == 0


def test_detect_contours_reports_geometry(binary_image):
    contours = cv.detect_contours(binary_image, min_area_pixels=10)
    assert len(contours) == 2
    # cv2.contourArea of a w x h pixel block is (w-1) * (h-1); largest first.
    assert contours[0]["area_pixels"] == pytest.approx(49 * 29, rel=0.02)
    assert contours[0]["perimeter_pixels"] > 0
    assert contours[0]["vertices"] >= 4
    assert len(contours[0]["points"]) >= 4
    assert cv.count_contours(binary_image) == 2


def test_edge_detection_methods(noisy_gray):
    for method in ("canny", "sobel", "laplacian", "scharr"):
        edges = cv.edge_detect(noisy_gray, method=method)
        assert edges.shape == noisy_gray.shape
        assert edges.dtype == np.uint8
    with pytest.raises(DataError):
        cv.edge_detect(noisy_gray, method="unknown")


def test_roi_and_crop_to_mask(binary_image):
    roi = cv.extract_roi(binary_image, 10, 10, 30, 20)
    assert roi.shape == (20, 30)
    assert (roi == 255).all()
    cropped = cv.crop_to_mask(binary_image, binary_image[:40, :50])
    assert cropped.shape[0] <= 40
    with pytest.raises(DataError):
        cv.extract_roi(binary_image, 500, 500, 10, 10)
    with pytest.raises(DataError):
        cv.crop_to_mask(binary_image, np.zeros_like(binary_image))


def test_overlay_and_annotation_outputs(binary_image):
    rgb = cv.to_display(binary_image)
    contours = cv.detect_contours(binary_image)
    overlay = cv.create_overlay(rgb, mask=binary_image, contours=contours, label="test")
    assert overlay.shape == (*binary_image.shape, 3)
    annotated = cv.annotate_contours(rgb, contours)
    assert annotated.shape == overlay.shape
    side = cv.side_by_side(rgb, overlay)
    assert side.shape[1] == rgb.shape[1] * 2 + 8


def test_process_image_pipeline_and_errors():
    image = np.zeros((60, 60), dtype="uint8")
    image[15:45, 15:45] = 180
    result = cv.process_image(image, ["grayscale", "blur", {"name": "otsu"}, "morph_open", "morph_close"])
    assert result["operation_count"] == 5
    assert result["binary"] is True
    assert result["contour_count"] == 1
    assert result["contours"][0]["area_pixels"] > 800
    assert [step["operation"] for step in result["steps"]] == ["grayscale", "blur", "otsu", "morph_open", "morph_close"]
    with pytest.raises(DataError) as error:
        cv.process_image(image, ["not_an_operation"])
    assert "Unknown operation" in str(error.value)


def test_available_operations_are_documented():
    operations = cv.available_operations()
    for expected in ("grayscale", "denoise", "otsu", "erode", "dilate", "morph_open", "morph_close", "edges", "clean_mask"):
        assert expected in operations
    assert cv.mask_coverage(np.array([[0, 255], [255, 255]], dtype="uint8")) == pytest.approx(0.75)


def test_encode_png_and_statistics():
    image = np.zeros((20, 20, 3), dtype="uint8")
    png = cv.encode_png(image)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    stats = cv.image_statistics(image)
    assert stats["shape"] == [20, 20]
    assert stats["mean_brightness"] == 0.0
