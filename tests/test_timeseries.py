"""Time-series engine tests."""
from __future__ import annotations

import numpy as np
import pytest

import timeseries as ts
from data import DataError


@pytest.fixture()
def growing_observations() -> list[dict]:
    # Evenly spaced dates (28 days apart) with a perfectly linear NDVI ramp.
    return [
        {"date": "2026-04-08", "mean": 0.42, "healthy_pct": 12.0, "weak_pct": 34.0},
        {"date": "2026-05-06", "mean": 0.53, "healthy_pct": 21.0, "weak_pct": 25.0},
        {"date": "2026-06-03", "mean": 0.64, "healthy_pct": 38.0, "weak_pct": 15.0},
    ]


def test_parse_date_accepts_common_formats():
    assert ts.parse_date("2026-04-08").isoformat() == "2026-04-08"
    assert ts.parse_date("2026/04/08").isoformat() == "2026-04-08"
    assert ts.parse_date("08-04-2026").isoformat() == "2026-04-08"
    with pytest.raises(DataError):
        ts.parse_date("not a date")
    with pytest.raises(DataError):
        ts.parse_date("")


def test_build_observation_schema(growing_observations):
    observation = ts.build_observation(
        "2026-04-08",
        index_name="NDVI",
        statistics={"mean": 0.42, "median": 0.4, "valid_pixels": 100},
        health={"healthy_pct": 12.0, "weak_pct": 34.0},
        dataset="field.tif",
    )
    assert observation["date"] == "2026-04-08"
    assert observation["mean"] == 0.42
    assert observation["healthy_pct"] == 12.0
    assert observation["day_index"] > 0


def test_build_timeseries_sorts_observations(growing_observations):
    shuffled = [growing_observations[2], growing_observations[0], growing_observations[1]]
    series = ts.build_timeseries(shuffled)
    assert series["dates"] == ["2026-04-08", "2026-05-06", "2026-06-03"]
    assert series["means"] == [0.42, 0.53, 0.64]
    assert series["count"] == 3
    assert series["span_days"] == 56
    assert series["first_date"] == "2026-04-08"


def test_build_timeseries_requires_observations():
    with pytest.raises(DataError):
        ts.build_timeseries([])


def test_compute_trend_on_perfectly_linear_series(growing_observations):
    series = ts.build_timeseries(growing_observations)
    trend = ts.compute_trend(series)
    assert trend["direction"] == "increasing"
    assert trend["r_squared"] == pytest.approx(1.0, abs=1e-6)
    assert trend["slope_per_day"] == pytest.approx((0.64 - 0.42) / 56, rel=0.02)
    assert trend["slope_per_30_days"] > 0
    assert "increasing" in trend["interpretation"]


def test_compute_trend_detects_decline_and_stability():
    declining = ts.build_timeseries([
        {"date": "2026-04-01", "mean": 0.7},
        {"date": "2026-05-01", "mean": 0.5},
        {"date": "2026-06-01", "mean": 0.3},
    ])
    assert ts.compute_trend(declining)["direction"] == "decreasing"

    stable = ts.build_timeseries([
        {"date": "2026-04-01", "mean": 0.5},
        {"date": "2026-05-01", "mean": 0.501},
    ])
    assert ts.compute_trend(stable)["direction"] == "stable"


def test_compute_trend_needs_two_points():
    single = ts.build_timeseries([{"date": "2026-04-01", "mean": 0.5}])
    trend = ts.compute_trend(single)
    assert trend["direction"] == "insufficient_data"
    assert trend["slope_per_day"] is None


def test_compute_change_reports_intervals_and_totals(growing_observations):
    series = ts.build_timeseries(growing_observations)
    change = ts.compute_change(series)
    assert change["total_change"] == pytest.approx(0.22, abs=1e-6)
    assert change["total_change_pct"] == pytest.approx(52.38, abs=0.1)
    assert change["direction"] == "increase"
    assert len(change["intervals"]) == 2
    assert change["intervals"][0]["days"] == 28
    assert change["intervals"][0]["direction"] == "increase"
    assert change["largest_increase"]["delta"] == pytest.approx(0.11, abs=1e-6)


def test_compute_change_marks_stable_intervals():
    series = ts.build_timeseries([{"date": "2026-04-01", "mean": 0.5}, {"date": "2026-04-15", "mean": 0.505}])
    change = ts.compute_change(series, change_threshold=0.05)
    assert change["intervals"][0]["direction"] == "stable"
    assert change["direction"] == "stable"


def test_health_trend_reports_percentage_point_changes(growing_observations):
    series = ts.build_timeseries(growing_observations)
    health = ts.health_trend(series)
    assert health["healthy_change_pp"] == pytest.approx(26.0)
    assert health["healthy_direction"] == "improving"
    assert health["weak_change_pp"] == pytest.approx(-19.0)
    assert health["weak_direction"] == "decreasing"


def test_analyze_timeseries_end_to_end(growing_observations):
    payload = ts.analyze_timeseries(growing_observations, index_name="NDVI")
    assert payload["summary"]["observation_count"] == 3
    assert payload["summary"]["mean_first"] == 0.42
    assert payload["summary"]["mean_last"] == 0.64
    assert payload["summary"]["mean_max"] == 0.64
    assert payload["summary"]["trend_direction"] == "increasing"
    assert payload["interpretation"]["points"]
    assert "not necessarily" in payload["interpretation"]["disclaimer"]
    assert payload["warnings"] == []


def test_analyze_timeseries_warns_about_missing_statistics_and_short_span():
    payload = ts.analyze_timeseries([{"date": "2026-04-01", "mean": 0.5}, {"date": "2026-04-02"}])
    assert any("no usable statistics" in warning for warning in payload["warnings"])
    assert any("less than a week" in warning or "observation" in warning for warning in payload["warnings"])


def test_observations_from_csv(tmp_path):
    csv_path = tmp_path / "history.csv"
    csv_path.write_text(
        "date,field,ndvi_mean,cloud_cover_pct\n"
        "2026-04-08,North Field,0.42,5.0\n"
        "2026-05-06,North Field,0.51,3.0\n"
        "2026-04-08,South Field,0.33,7.0\n",
        encoding="utf-8",
    )
    payload = ts.observations_from_csv(str(csv_path))
    assert payload["rows"] == 3
    assert payload["group_column"] == "field"
    series = ts.build_timeseries(payload["observations"])
    assert series["count"] == 3
    # Sorting is by date only (stable), so same-date rows keep their order.
    assert series["means"][0] == pytest.approx(0.42)


def test_observations_from_csv_requires_columns(tmp_path):
    csv_path = tmp_path / "bad.csv"
    csv_path.write_text("when,temperature\n2026-04-08,21\n", encoding="utf-8")
    with pytest.raises(DataError):
        ts.observations_from_csv(str(csv_path))


def test_compare_index_rasters_reuses_change_detection():
    before = np.array([[0.2, 0.5]], dtype="float32")
    after = np.array([[0.4, 0.5]], dtype="float32")
    result = ts.compare_index_rasters(before, after)
    assert result["mean_change"] == pytest.approx(0.1)
