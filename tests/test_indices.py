"""Vegetation index engine tests (NDVI first)."""
from __future__ import annotations

import numpy as np
import pytest

import indices
from data import RasterError


def test_ndvi_formula_matches_manual_calculation():
    red = np.array([[0.20, 0.10], [0.30, 0.00]], dtype="float32")
    nir = np.array([[0.50, 0.40], [0.30, 0.20]], dtype="float32")
    ndvi = indices.compute_ndvi(red, nir)
    expected = (nir - red) / (nir + red)
    assert np.allclose(ndvi, expected, atol=1e-6)
    assert ndvi[0, 0] == pytest.approx(0.4285714, abs=1e-6)


def test_ndvi_handles_zero_denominator_without_inf_or_nan():
    red = np.array([0.0, 0.2, -0.1], dtype="float32")
    nir = np.array([0.0, -0.2, 0.1], dtype="float32")
    ndvi = indices.compute_ndvi(red, nir)
    assert np.isfinite(ndvi).all()
    assert ndvi[0] == 0.0
    assert ndvi[1] == 0.0


def test_ndvi_is_clipped_to_physically_valid_range():
    red = np.array([-1.0, 5.0], dtype="float32")
    nir = np.array([1.0, 0.1], dtype="float32")
    ndvi = indices.compute_ndvi(red, nir)
    assert ndvi.min() >= -1.0
    assert ndvi.max() <= 1.0


def test_ndvi_marks_invalid_pixels_as_nan():
    red = np.array([0.2, 0.2], dtype="float32")
    nir = np.array([0.5, 0.5], dtype="float32")
    valid = np.array([True, False])
    ndvi = indices.compute_ndvi(red, nir, valid=valid)
    assert np.isfinite(ndvi[0])
    assert np.isnan(ndvi[1])


def test_safe_divide_never_raises_or_returns_inf():
    numerator = np.array([1.0, 0.0, -1.0], dtype="float32")
    denominator = np.array([0.0, 0.0, 2.0], dtype="float32")
    result = indices.safe_divide(numerator, denominator)
    assert np.isfinite(result).all()
    assert result[0] == 0.0 and result[1] == 0.0
    assert result[2] == pytest.approx(-0.5)


def test_index_statistics_on_known_array():
    array = np.array([0.1, 0.2, 0.3, 0.4, 0.5], dtype="float32")
    stats = indices.index_statistics(array)
    assert stats["valid_pixels"] == 5
    assert stats["min"] == pytest.approx(0.1)
    assert stats["max"] == pytest.approx(0.5)
    assert stats["mean"] == pytest.approx(0.3)
    assert stats["median"] == pytest.approx(0.3)
    assert stats["std"] == pytest.approx(0.1414, abs=1e-3)
    assert stats["valid_ratio"] == 1.0
    assert len(stats["histogram"]["counts"]) == 20


def test_index_statistics_ignores_nan_and_reports_empty_case():
    mixed = np.array([0.2, np.nan, 0.6], dtype="float32")
    stats = indices.index_statistics(mixed)
    assert stats["valid_pixels"] == 2
    assert stats["mean"] == pytest.approx(0.4)
    empty = indices.index_statistics(np.array([np.nan, np.nan], dtype="float32"))
    assert empty["valid_pixels"] == 0
    assert empty["mean"] is None
    assert empty["histogram"]["counts"] == []


def test_index_statistics_respects_valid_mask():
    array = np.array([0.2, 0.8, 0.9], dtype="float32")
    valid = np.array([True, False, True])
    stats = indices.index_statistics(array, valid=valid)
    assert stats["valid_pixels"] == 2
    assert stats["mean"] == pytest.approx(0.55)


def test_generalised_classes_are_percentages():
    values = np.array([-0.2, 0.1, 0.3, 0.5, 0.7], dtype="float32")
    classes = indices.generalised_ndvi_classes(values)
    assert classes["negative_or_water"] == pytest.approx(20.0)
    assert classes["bare_soil"] == pytest.approx(20.0)
    assert classes["sparse_vegetation"] == pytest.approx(20.0)
    assert classes["moderate_vegetation"] == pytest.approx(20.0)
    assert classes["dense_vegetation"] == pytest.approx(20.0)


def test_other_indices_are_implemented():
    red = np.array([0.1], dtype="float32")
    nir = np.array([0.4], dtype="float32")
    blue = np.array([0.05], dtype="float32")
    edge = np.array([0.2], dtype="float32")
    assert indices.compute_ndre(nir, edge)[0] == pytest.approx((0.4 - 0.2) / (0.4 + 0.2), abs=1e-6)
    savi = indices.compute_savi(nir, red, l=0.5)[0]
    assert savi == pytest.approx(((0.4 - 0.1) / (0.4 + 0.1 + 0.5)) * 1.5, abs=1e-6)
    evi = indices.compute_evi(nir, red, blue)[0]
    assert evi == pytest.approx(2.5 * (0.4 - 0.1) / (0.4 + 6 * 0.1 - 7.5 * 0.05 + 1.0), abs=1e-5)


def test_compute_index_dispatches_and_reports_missing_bands():
    bands = {"red": np.array([0.2], dtype="float32"), "nir": np.array([0.5], dtype="float32")}
    result = indices.compute_index("ndvi", bands)
    assert result["name"] == "NDVI"
    assert result["bands_used"] == ["red", "nir"]
    with pytest.raises(indices.VegetationIndexError) as error:
        indices.compute_index("NDRE", bands)
    assert "red_edge" in str(error.value)


def test_band_resolution_prefers_band_descriptions():
    metadata = {"band_count": 4, "band_descriptions": ["B02", "B03", "B04", "B08"], "band_tags": {}}
    resolved = indices.resolve_band_map(metadata)
    assert resolved["method"] == "band_descriptions"
    assert resolved["bands"]["red"] == 3
    assert resolved["bands"]["nir"] == 4
    assert resolved["assumption_warning"] is False


def test_band_resolution_uses_configured_fallback_with_warning():
    metadata = {"band_count": 4, "band_descriptions": ["", "", "", ""], "band_tags": {}}
    resolved = indices.resolve_band_map(metadata)
    assert resolved["method"] == "config_fallback"
    assert resolved["assumption_warning"] is True
    assert resolved["bands"]["nir"] == 4


def test_band_resolution_honours_explicit_request_and_validates_range():
    metadata = {"band_count": 4, "band_descriptions": ["B02", "B03", "B04", "B08"], "band_tags": {}}
    resolved = indices.resolve_band_map(metadata, {"red": 4, "nir": 3})
    assert resolved["method"] == "explicit"
    assert resolved["bands"]["red"] == 4 and resolved["bands"]["nir"] == 3
    with pytest.raises(indices.VegetationIndexError):
        indices.resolve_band_map(metadata, {"nir": 9})


def test_band_resolution_explains_impossible_fallback_for_small_rasters():
    metadata = {"band_count": 1, "band_descriptions": ["pan"], "band_tags": {}}
    with pytest.raises(indices.VegetationIndexError) as error:
        indices.resolve_band_map(metadata)
    assert "band_map" in str(error.value)


def test_index_registry_metadata_is_complete():
    for entry in indices.available_indices():
        assert entry["name"] in indices.INDEX_REGISTRY
        assert entry["bands"]
        low, high = entry["range"]
        assert low < high, f"{entry['name']} declares a degenerate range"
        assert entry["normalized"] in (True, False)
        # A difference-normalised index is bounded to [-1, 1] by construction;
        # a ratio index is only bounded below and must say so.
        if entry["normalized"]:
            assert entry["range"] == [-1.0, 1.0]
        else:
            assert entry["range"][0] >= 0.0
        assert entry["typical_vegetation_range"][0] < entry["typical_vegetation_range"][1]
        assert entry["sensor_hint"]
    with pytest.raises(indices.VegetationIndexError):
        indices.normalise_index_name("NBRX")


def test_compare_index_statistics_computes_deltas():
    before = {"mean": 0.4, "median": 0.4, "min": 0.1, "max": 0.7, "std": 0.1}
    after = {"mean": 0.5, "median": 0.45, "min": 0.15, "max": 0.75, "std": 0.12}
    delta = indices.compare_index_statistics(before, after)
    assert delta["mean"] == pytest.approx(0.1)
    assert delta["mean_change_pct"] == pytest.approx(25.0)


def test_classify_pixel_labels():
    assert indices.classify_index_pixel(0.9) == "dense_vegetation"
    assert indices.classify_index_pixel(0.1) == "bare_soil"
    assert indices.classify_index_pixel(-0.2) == "negative_or_water"
    assert indices.classify_index_pixel(float("nan")) == "unknown"
