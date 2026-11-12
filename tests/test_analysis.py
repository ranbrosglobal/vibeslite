"""Crop-health engine tests."""
from __future__ import annotations

import numpy as np
import pytest
from rasterio.transform import from_origin

import analysis


def test_thresholds_come_from_configuration():
    thresholds = analysis.thresholds_from_config()
    assert set(thresholds) == {"very_low", "low", "moderate", "healthy"}
    assert analysis.health_class_boundaries() == [0.20, 0.40, 0.60, 0.80]


def test_classify_health_assigns_expected_classes():
    values = np.array([-0.2, 0.05, 0.19, 0.20, 0.39, 0.40, 0.59, 0.60, 0.79, 0.80, 0.95], dtype="float32")
    classes = analysis.classify_health(values)
    assert classes.tolist() == [0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4]


def test_classify_health_marks_invalid_pixels():
    values = np.array([0.5, np.nan, 0.9], dtype="float32")
    valid = np.array([True, True, False])
    classes = analysis.classify_health(values, valid=valid)
    assert classes[0] == 2
    assert classes[1] == -1
    assert classes[2] == -1


def test_classify_health_respects_custom_thresholds():
    values = np.array([0.35], dtype="float32")
    assert analysis.classify_health(values)[0] == 1
    custom = {"very_low": 0.30, "low": 0.50, "moderate": 0.70, "healthy": 0.85}
    assert analysis.classify_health(values, thresholds=custom)[0] == 1
    assert analysis.classify_health(np.array([0.45], dtype="float32"), thresholds=custom)[0] == 1
    assert analysis.classify_health(np.array([0.55], dtype="float32"), thresholds=custom)[0] == 2


def test_thresholds_must_be_ascending():
    bad = {"very_low": 0.6, "low": 0.4, "moderate": 0.2, "healthy": 0.1}
    with pytest.raises(Exception):
        analysis.classify_health(np.array([0.5], dtype="float32"), thresholds=bad)


def test_classify_pixel_reports_label_colour_and_range():
    entry = analysis.classify_pixel(0.83)
    assert entry["key"] == "very_healthy"
    assert entry["colour"].startswith("#")
    assert entry["range"][0] == 0.8


def test_health_statistics_are_percentages_that_sum_to_100(simple_ndvi_grid):
    classes = analysis.classify_health(simple_ndvi_grid)
    stats = analysis.health_statistics(classes, pixel_area_ha=0.01)
    total = sum(entry["percentage"] for entry in stats["classes"])
    # Percentages are rounded to 3 decimals, so allow for rounding spill.
    assert total == pytest.approx(100.0, abs=0.01)
    assert stats["valid_pixels"] == simple_ndvi_grid.size
    assert stats["dominant_class"] in analysis.health_class_keys()
    # 0.85 and 0.95 fall in the very-healthy class, 0.65/0.75 in healthy.
    assert stats["by_key"]["very_healthy"]["pixels"] == 2
    assert stats["healthy_area_ha"] == pytest.approx(4 * 0.01)


def test_health_statistics_handles_all_invalid():
    classes = np.full((3, 3), -1, dtype="int8")
    stats = analysis.health_statistics(classes)
    assert stats["valid_pixels"] == 0
    assert stats["healthy_pct"] == 0.0
    assert stats["coverage_pct"] == 0.0
    assert stats["dominant_class"] is None


def test_health_colour_map_uses_class_palette(simple_ndvi_grid):
    classes = analysis.classify_health(simple_ndvi_grid)
    rgb = analysis.health_colour_map(classes)
    assert rgb.shape == (*simple_ndvi_grid.shape, 3)
    assert tuple(rgb[0, 0]) == tuple(int(analysis.HEALTH_CLASSES[0]["colour"][i : i + 2], 16) for i in (1, 3, 5))


def test_health_zones_polygonise_with_areas():
    grid = np.full((40, 40), 0.9, dtype="float32")
    grid[:10, :10] = 0.1
    classes = analysis.classify_health(grid)
    transform = from_origin(250000, 4540000, 10, 10)
    result = analysis.health_zones(classes, transform, "EPSG:32633", min_area_ha=0.0)
    assert result["total_zones"] >= 2
    assert result["zone_count"]["very_low"] >= 1
    very_low_zone = result["zones"]["very_low"][0]
    # 10x10 pixels of 10 m => 1 ha
    assert very_low_zone["area_ha"] == pytest.approx(1.0, rel=0.02)
    assert -180 <= very_low_zone["centroid_lonlat"][0] <= 180
    assert -90 <= very_low_zone["centroid_lonlat"][1] <= 90


def test_weak_vegetation_detection_cleans_noise():
    grid = np.full((60, 60), 0.75, dtype="float32")
    grid[10:30, 10:30] = 0.15  # real patch: 20x20 px = 4 ha at 10 m
    grid[50, 50] = 0.16  # isolated speck that morphology should remove
    transform = from_origin(250000, 4540000, 10, 10)
    result = analysis.detect_weak_vegetation(
        grid,
        transform,
        "EPSG:32633",
        weak_threshold=0.4,
        min_area_ha=0.05,
        pixel_area_ha=0.01,
    )
    assert result["patch_count"] == 1
    assert result["pixels_raw"] == 401  # 400 px patch + 1 noise pixel
    # Morphological opening rounds corners, so the cleaned patch is slightly
    # smaller than 400 px; the isolated speck is gone entirely.
    assert 380 <= result["pixels_cleaned"] <= 400
    assert result["area_ha"] == pytest.approx(3.9, rel=0.05)
    assert result["largest_patch_ha"] == pytest.approx(3.9, rel=0.05)
    assert result["morphology"]["applied"] is True
    assert result["morphology"]["removed_pixels"] >= 1


def test_weak_vegetation_excludes_negative_values_by_default():
    grid = np.array([[-0.3, 0.1, 0.9]], dtype="float32")
    transform = from_origin(250000, 4540000, 10, 10)
    default = analysis.detect_weak_vegetation(grid, transform, "EPSG:32633", weak_threshold=0.4, min_area_ha=0.0, cleanup=False)
    assert default["pixels_raw"] == 1  # only the 0.1 pixel
    inclusive = analysis.detect_weak_vegetation(
        grid, transform, "EPSG:32633", weak_threshold=0.4, min_area_ha=0.0, include_negative=True, cleanup=False
    )
    assert inclusive["pixels_raw"] == 2


def test_detect_anomalies_zscore_and_iqr():
    rng = np.random.default_rng(3)
    grid = rng.normal(0.6, 0.03, (50, 50)).astype("float32")
    grid[0:5, 0:5] = 0.2
    zscore = analysis.detect_anomalies(grid, method="zscore", threshold=2.0)
    assert zscore["low_pixels"] >= 25
    assert zscore["low_percentage"] > 0
    iqr = analysis.detect_anomalies(grid, method="iqr")
    assert iqr["method"] == "iqr"
    assert iqr["low_mask"].dtype == bool


def test_ndvi_change_detects_improvement_and_decline():
    before = np.array([[0.2, 0.6], [0.5, 0.4]], dtype="float32")
    after = np.array([[0.4, 0.6], [0.3, 0.4]], dtype="float32")
    result = analysis.ndvi_change(before, after)
    assert result["delta"][0, 0] == pytest.approx(0.2, abs=1e-6)
    assert result["improved_pixels"] == 1
    assert result["degraded_pixels"] == 1
    assert result["stable_pixels"] == 2
    with pytest.raises(Exception):
        analysis.ndvi_change(before, np.array([0.1], dtype="float32"))


def test_field_summary_and_interpretation_are_conservative(simple_ndvi_grid):
    import indices

    statistics = indices.index_statistics(simple_ndvi_grid)
    classes = analysis.classify_health(simple_ndvi_grid)
    health = analysis.health_statistics(classes, pixel_area_ha=0.01)
    weak = analysis.detect_weak_vegetation(
        simple_ndvi_grid,
        from_origin(250000, 4540000, 10, 10),
        "EPSG:32633",
        min_area_ha=0.0,
    )
    anomalies = analysis.detect_anomalies(simple_ndvi_grid)
    summary = analysis.field_summary(
        index_name="NDVI",
        statistics=statistics,
        health=health,
        weak_vegetation=weak,
        anomalies=anomalies,
        field_area_ha=1.2,
    )
    summary["largest_patch_ha"] = weak["largest_patch_ha"]
    interpretation = analysis.interpret(summary)
    assert summary["vigour_score"] is not None
    assert interpretation["verdict"]
    assert interpretation["points"]
    assert "not a diagnosis" in interpretation["disclaimer"]
    for point in interpretation["points"]:
        assert "disease" not in point.lower()


def test_health_change_direction():
    before = {"mean_index": 0.4, "healthy_pct": 10.0, "weak_pct": 30.0}
    after = {"mean_index": 0.55, "healthy_pct": 25.0, "weak_pct": 12.0}
    change = analysis.health_change(before, after)
    assert change["direction"] == "improving"
    assert change["healthy_pct_delta"] == pytest.approx(15.0)
    assert change["change_pct"] == pytest.approx(37.5)


def test_vegetation_share_counts_pixels_above_threshold():
    grid = np.array([0.1, 0.2, 0.3, 0.4], dtype="float32")
    assert analysis.vegetation_share(grid, threshold=0.2) == pytest.approx(75.0)
