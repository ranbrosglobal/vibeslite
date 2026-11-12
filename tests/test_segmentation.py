"""Segmentation engine tests (classical methods + AI-ready registry)."""
from __future__ import annotations

import numpy as np
import pytest
from rasterio.transform import from_origin

import segmentation
from data import DataError


@pytest.fixture()
def index_grid() -> np.ndarray:
    grid = np.full((60, 60), 0.15, dtype="float32")
    grid[5:35, 5:35] = 0.7
    grid[45:55, 45:55] = 0.55
    return grid


def test_threshold_segment_above_and_below(index_grid):
    above = segmentation.threshold_segment(index_grid, threshold=0.5, comparison="above")
    assert above.sum() == 30 * 30 + 10 * 10
    below = segmentation.threshold_segment(index_grid, threshold=0.2, comparison="below")
    assert below.sum() == index_grid.size - above.sum()
    with pytest.raises(DataError):
        segmentation.threshold_segment(index_grid, comparison="sideways")


def test_threshold_segment_ignores_nan_and_optional_valid_mask(index_grid):
    with_nan = index_grid.copy()
    with_nan[0, 0] = np.nan
    mask = segmentation.threshold_segment(with_nan, threshold=0.5)
    assert not mask[0, 0]
    valid = np.zeros(index_grid.shape, dtype=bool)
    valid[5:35, 5:35] = True
    assert segmentation.threshold_segment(index_grid, threshold=0.1, valid=valid).sum() == 900


def test_multi_threshold_segment_uses_health_boundaries(index_grid):
    classes = segmentation.multi_threshold_segment(index_grid)
    assert classes[0, 0] == 0  # 0.15 -> very low
    assert classes[10, 10] == 3  # 0.7 -> healthy
    assert classes[50, 50] == 2  # 0.55 -> moderate
    custom = segmentation.multi_threshold_segment(index_grid, boundaries=[0.2, 0.4, 0.6, 0.8])
    assert custom[10, 10] == 3


def test_otsu_segment_returns_threshold(index_grid):
    result = segmentation.otsu_segment(index_grid)
    assert result["mask"].dtype == bool
    assert result["threshold_value"] is not None
    assert result["method"] == "otsu"
    empty = segmentation.otsu_segment(np.full((5, 5), np.nan, dtype="float32"))
    assert empty["mask"].sum() == 0


def test_refine_and_connected_components(index_grid):
    raw = segmentation.threshold_segment(index_grid, threshold=0.5)
    components = segmentation.connected_components(raw, min_area_pixels=10)
    assert components["component_count"] == 2
    assert components["components"][0]["area_pixels"] == 900
    assert components["labels"].shape == index_grid.shape
    refined = segmentation.refine_segmentation_mask(raw, min_area_pixels=50)
    refined_pixels = int((np.asarray(refined["mask"]) > 0).sum())
    # Morphological opening rounds the square corners, so the large square loses
    # ~10% of its pixels; the 100 px blob still survives the area filter.
    assert 850 <= refined_pixels <= 1000
    components = segmentation.connected_components(np.asarray(refined["mask"]) > 0, min_area_pixels=50)
    assert components["component_count"] == 2
    assert components["components"][0]["area_pixels"] > components["components"][1]["area_pixels"]


def test_extract_segment_contours(index_grid):
    mask = segmentation.threshold_segment(index_grid, threshold=0.5)
    contours = segmentation.extract_segment_contours(mask, min_area_pixels=50)
    assert len(contours) == 2
    assert contours[0]["area_pixels"] > contours[1]["area_pixels"]


def test_segmentation_statistics_reports_areas():
    classes = np.array([[0, 0, 1], [1, 1, -1]], dtype="int16")
    stats = segmentation.segmentation_statistics(classes, pixel_area_ha=0.5)
    assert stats["class_count"] == 2
    assert stats["valid_pixels"] == 5
    assert stats["classes"][0]["pixels"] == 2
    assert stats["classes"][0]["area_ha"] == pytest.approx(1.0)
    assert stats["coverage_pct"] == pytest.approx(83.333, abs=0.01)


def test_run_segmentation_georeferenced(index_grid):
    transform = from_origin(250000, 4540000, 10, 10)
    result = segmentation.run_segmentation(
        index_grid,
        method="threshold",
        params={"threshold": 0.5},
        transform=transform,
        crs="EPSG:32633",
        pixel_area_ha=0.01,
        min_area_ha=0.05,
    )
    assert result["provider"] == "classical"
    assert result["method"] == "threshold"
    assert result["mask_coverage_pct"] > 0
    assert result["component_count"] == 2
    assert result["area_ha"] == pytest.approx(10.0, rel=0.05)
    assert result["segments_geojson"]["type"] == "FeatureCollection"
    assert len(result["segments"]) == 2
    assert result["segments"][0]["area_ha"] == pytest.approx(9.0, rel=0.05)


def test_run_segmentation_without_georeferencing(index_grid):
    result = segmentation.run_segmentation(index_grid, method="multi_threshold", min_area_ha=0.05)
    assert result["segments_geojson"] is None
    assert result["segments"] == []
    assert result["class_raster"] is not None
    assert result["statistics"]["class_count"] >= 3


def test_run_segmentation_unknown_method_lists_options(index_grid):
    with pytest.raises(DataError) as error:
        segmentation.run_segmentation(index_grid, method="magic")
    assert "threshold" in str(error.value)


def test_model_registry_reports_unavailable_models_with_hints():
    methods = segmentation.available_methods()
    assert methods["default"] == "threshold"
    assert {entry["key"] for entry in methods["classical"]} == {"threshold", "otsu", "multi_threshold", "zones"}
    models = {entry["key"]: entry for entry in methods["models"]}
    assert models["unet"]["available"] is False
    assert "install_hint" in models["unet"]
    with pytest.raises(DataError) as error:
        segmentation.run_segmentation(np.zeros((5, 5), dtype="float32"), method="unet")
    assert "not available" in str(error.value)


def test_register_model_plugs_a_custom_predictor_into_the_pipeline(index_grid):
    """A U-Net / TorchScript style loader can be registered without code changes."""

    def fake_loader(array: np.ndarray, threshold: float = 0.5, **_: object):
        return {"mask": np.asarray(array) > threshold, "classes": np.asarray(array) > threshold}

    entry = segmentation.register_model("test_unet", fake_loader, task="segmentation", label="Test U-Net")
    assert entry["available"] is True
    try:
        result = segmentation.run_segmentation(index_grid, method="test_unet", params={"threshold": 0.5}, min_area_ha=0.05)
        assert result["provider"] == "model"
        assert result["component_count"] == 2
        assert result["model"] is True
        models = {item["key"]: item for item in segmentation.available_methods()["models"]}
        assert models["test_unet"]["registered"] is True
    finally:
        segmentation._model_loaders.pop("test_unet", None)
        segmentation.MODEL_REGISTRY.pop("test_unet", None)


def test_summarise_segments_returns_largest_first():
    segments = [{"area_ha": 1.0, "label": "a"}, {"area_ha": 5.0, "label": "b"}, {"area_ha": 3.0, "label": "c"}]
    summary = segmentation.summarise_segments(segments, top=2)
    assert [item["label"] for item in summary] == ["b", "c"]
