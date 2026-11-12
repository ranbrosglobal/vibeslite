"""Tests for the agronomy decision engine.

The engine's contract is as much about honesty as about arithmetic, so these
tests check both: the numbers follow the published method, and the models refuse
to invent a value they cannot support (an uncalibrated yield coefficient must
return a calibration request, never a tonnage).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import agronomy  # noqa: E402


# --------------------------------------------------------------------------- #
# thermal time
# --------------------------------------------------------------------------- #
class TestThermalTime:
    def test_average_method_matches_the_hand_calculation(self):
        result = agronomy.growing_degree_days([10.0, 12.0, 5.0], [20.0, 22.0, 15.0], base_c=10.0, upper_c=None)
        # (20+10)/2-10 = 5 ; (22+12)/2-10 = 7 ; (15+5)/2-10 = 0
        assert result["daily"] == [5.0, 7.0, 0.0]
        assert result["cumulative"] == [5.0, 12.0, 12.0]
        assert result["total"] == 12.0

    def test_upper_cutout_caps_tmax_at_the_ceiling(self):
        uncapped = agronomy.growing_degree_days([20.0], [40.0], base_c=10.0, upper_c=None)
        capped = agronomy.growing_degree_days([20.0], [40.0], base_c=10.0, upper_c=30.0)
        assert uncapped["daily"][0] == 20.0
        # Tmax is cut to 30 while Tmin (20) is already below the ceiling.
        assert capped["daily"][0] == 15.0

    def test_upper_cutout_floors_a_contribution_when_tmin_exceeds_the_ceiling(self):
        # A 34-42 C day with a 30 C ceiling must contribute exactly (cap - base),
        # not the average of the uncapped range, which would overstate growth.
        result = agronomy.growing_degree_days([34.0], [42.0], base_c=10.0, upper_c=30.0)
        assert result["daily"][0] == 20.0

    def test_modified_method_floors_tmin_at_base(self):
        average = agronomy.growing_degree_days([2.0], [20.0], base_c=10.0, upper_c=None, method="average")
        modified = agronomy.growing_degree_days([2.0], [20.0], base_c=10.0, upper_c=None, method="modified")
        assert average["daily"][0] == 1.0  # (20+2)/2-10
        assert modified["daily"][0] == 5.0  # (20+10)/2-10

    def test_sine_method_is_between_the_two_extremes(self):
        sine = agronomy.growing_degree_days([2.0], [20.0], base_c=10.0, upper_c=None, method="sine")
        assert 1.0 < sine["daily"][0] < 5.0

    def test_sine_method_is_zero_when_the_whole_day_is_below_base(self):
        result = agronomy.growing_degree_days([0.0], [4.0], base_c=10.0, upper_c=None, method="sine")
        assert result["daily"][0] == 0.0

    def test_a_reversed_daily_range_is_repaired_and_reported(self):
        result = agronomy.growing_degree_days([25.0], [15.0], base_c=10.0, upper_c=None)
        assert result["swapped_ranges"] == 1
        assert result["daily"][0] == 10.0  # treated as Tmin 15 / Tmax 25

    def test_no_negative_degree_days_are_ever_returned(self):
        result = agronomy.growing_degree_days([-5.0, -2.0], [-1.0, 0.0], base_c=10.0, upper_c=None)
        assert all(value == 0.0 for value in result["daily"])

    def test_methods_and_lengths_are_reported(self):
        with pytest.raises(ValueError):
            agronomy.growing_degree_days([1.0], [2.0], method="magic")
        with pytest.raises(ValueError):
            agronomy.growing_degree_days([1.0, 2.0], [2.0])
        with pytest.raises(ValueError):
            agronomy.growing_degree_days([], [])

    def test_phenology_walks_the_stages_as_heat_accumulates(self):
        spec = agronomy.CROP_COEFFICIENTS["maize"]
        boundaries = []
        running = 0.0
        total_days = sum(spec["stages_days"])
        for length in spec["stages_days"]:
            running += spec["gdd_maturity"] * length / total_days
            boundaries.append(running)

        first = agronomy.phenology_from_gdd(10.0, crop="maize")
        assert first["stage"] == "initial"
        assert first["season_progress_pct"] < 5

        mid = agronomy.phenology_from_gdd(boundaries[1] + 1.0, crop="maize")
        assert mid["stage"] == "mid_season"

        end = agronomy.phenology_from_gdd(spec["gdd_maturity"] * 2, crop="maize")
        assert end["stage"] == "late_season"
        assert end["season_progress_pct"] == 100.0

    def test_phenology_accepts_local_stage_lengths(self):
        result = agronomy.phenology_from_gdd(500.0, crop="wheat", stage_days=[10, 10, 10, 10])
        assert result["coefficients_used"]["stage_days"] == [10, 10, 10, 10]
        assert result["stages_gdd"][-1] == agronomy.CROP_COEFFICIENTS["wheat"]["gdd_maturity"]


# --------------------------------------------------------------------------- #
# water balance
# --------------------------------------------------------------------------- #
class TestWaterBalance:
    def test_dry_spell_triggers_irrigation(self):
        """A rainless spell at 6 mm/day ETc must schedule watering once the
        root zone passes the depletion trigger.

        Loam holds 160 mm/m, so with a 55% trigger the raw threshold is 88 mm —
        about 15 days of demand. The window here is comfortably past it.
        """
        result = agronomy.water_balance([6.0] * 20, [0.0] * 20, crop="maize", soil="loam")
        assert result["raw_mm"] == pytest.approx(88.0)
        assert result["irrigation_total_mm"] > 0
        assert result["event_count"] >= 1
        assert result["effective_rain_total_mm"] == 0.0
        # Gross applied exceeds net removed, because efficiency < 1.
        assert result["irrigation_total_mm"] > sum(event["net_mm"] for event in result["irrigation_events"])

    def test_a_wet_window_needs_no_irrigation(self):
        result = agronomy.water_balance([3.0] * 10, [20.0] * 10, crop="maize", soil="loam")
        assert result["irrigation_total_mm"] == 0
        assert result["verdict"] == "no irrigation required over this window"

    def test_small_showers_are_discarded_as_ineffective(self):
        result = agronomy.water_balance([0.0] * 4, [1.0, 2.0, 3.0, 3.9], min_rain_mm=4.0)
        assert result["effective_rain_total_mm"] == 0.0
        assert result["rainfall_total_mm"] == pytest.approx(9.9)

    def test_effective_rainfall_applies_the_effectiveness_factor(self):
        result = agronomy.water_balance([0.0], [10.0], rainfall_effectiveness=0.5, min_rain_mm=4.0)
        assert result["effective_rain_total_mm"] == 5.0

    def test_depletion_never_goes_negative_and_surplus_drains(self):
        result = agronomy.water_balance([0.0] * 3, [0.0, 100.0, 0.0], soil="sand", rainfall_effectiveness=1.0)
        assert all(row["depletion_mm"] >= 0 for row in result["daily"])
        assert result["daily"][1]["percolation_mm"] > 0

    def test_water_stress_coefficient_drops_when_depletion_passes_raw(self):
        # Sand holds only 70 mm/m: a 90% trigger puts the raw threshold at 63 mm,
        # which nine rainless 8 mm days exceed.
        result = agronomy.water_balance([8.0] * 9, [0.0] * 9, soil="sand", depletion_trigger_pct=90.0)
        assert result["raw_mm"] == pytest.approx(63.0)
        assert result["stress_days"] > 0
        assert min(row["ks"] for row in result["daily"]) < 1.0

    def test_soil_texture_changes_the_total_available_water(self):
        sand = agronomy.water_balance([5.0], [0.0], soil="sand")
        clay = agronomy.water_balance([5.0], [0.0], soil="clay")
        assert clay["taw_mm"] > sand["taw_mm"]

    def test_root_depth_scales_total_available_water(self):
        shallow = agronomy.water_balance([5.0], [0.0], root_depth_m=0.5)
        deep = agronomy.water_balance([5.0], [0.0], root_depth_m=1.5)
        assert deep["taw_mm"] == pytest.approx(shallow["taw_mm"] * 3, rel=1e-6)

    def test_explicit_kc_series_is_honoured_and_reported(self):
        result = agronomy.water_balance([5.0, 5.0], [0.0, 0.0], kc=[0.5, 1.5])
        assert result["kc_source"].startswith("explicit per-day")
        assert result["daily"][1]["etc_mm"] == 7.5

    def test_every_response_states_its_coefficients_and_caveats(self):
        result = agronomy.water_balance([5.0], [0.0])
        assert result["method"].startswith("FAO-56")
        assert result["coefficients_used"]["irrigation_efficiency"] == 0.75
        assert any("regional averages" in caveat for caveat in result["caveats"])

    def test_mismatched_series_are_rejected(self):
        with pytest.raises(ValueError):
            agronomy.water_balance([5.0, 5.0], [0.0])
        with pytest.raises(ValueError):
            agronomy.water_balance([5.0], [0.0], kc=[0.5, 0.5])


# --------------------------------------------------------------------------- #
# management zones
# --------------------------------------------------------------------------- #
class TestManagementZones:
    @staticmethod
    def _three_band_field(shape=(60, 60)):
        """Three horizontal bands of clearly different values."""
        grid = np.zeros(shape, dtype="float32")
        grid[0:20, :] = 0.25
        grid[20:40, :] = 0.55
        grid[40:, :] = 0.85
        return grid

    def test_zones_recover_three_obvious_bands(self):
        result = agronomy.management_zones(self._three_band_field(), n_zones=3)
        assert result["verdict"] == "ok"
        assert len(result["zones"]) == 3
        means = [zone["index_mean"] for zone in result["zones"]]
        assert means == sorted(means), "zone 0 must be the weakest zone"
        assert means[0] == pytest.approx(0.25, abs=0.05)
        assert means[-1] == pytest.approx(0.85, abs=0.05)

    def test_zone_shares_sum_to_about_one_hundred_percent(self):
        result = agronomy.management_zones(self._three_band_field(), n_zones=3)
        assert sum(zone["share_pct"] for zone in result["zones"]) == pytest.approx(100.0, abs=0.5)

    def test_separation_strength_is_reported(self):
        strong = agronomy.management_zones(self._three_band_field(), n_zones=3)
        assert strong["separation"] == "strong"

        flat = np.full((40, 40), 0.5, dtype="float32")
        flat[20:, :] = 0.505
        marginal = agronomy.management_zones(flat, n_zones=2)
        assert marginal["separation"] in {"marginal", "weak"}

    def test_the_result_is_deterministic(self):
        grid = np.random.default_rng(3).random((40, 40)).astype("float32")
        first = agronomy.management_zones(grid, n_zones=4)
        second = agronomy.management_zones(grid, n_zones=4)
        assert [zone["index_mean"] for zone in first["zones"]] == [zone["index_mean"] for zone in second["zones"]]
        assert np.array_equal(first["zone_map"], second["zone_map"])

    def test_nan_and_masked_pixels_are_excluded(self):
        grid = self._three_band_field()
        grid[0:5, :] = np.nan
        mask = np.ones(grid.shape, dtype=bool)
        mask[:, 0:10] = False
        result = agronomy.management_zones(grid, mask=mask, n_zones=3)
        assert result["verdict"] == "ok"
        assert result["zone_map"][0, 0] == -1, "invalid pixels are marked, not assigned"
        assert result["zone_map"][30, 30] >= 0

    def test_an_empty_mask_reports_insufficient_data(self):
        result = agronomy.management_zones(np.full((10, 10), np.nan, dtype="float32"), n_zones=3)
        assert result["verdict"] == "insufficient_data"
        assert result["zones"] == []

    def test_more_zones_than_pixels_does_not_explode(self):
        result = agronomy.management_zones(np.full((3, 3), 0.4, dtype="float32"), n_zones=8)
        assert result["verdict"] == "ok"
        assert len(result["zones"]) <= 9

    def test_a_large_raster_is_strided_and_says_so(self):
        big = np.random.default_rng(7).random((700, 700)).astype("float32")
        result = agronomy.management_zones(big, n_zones=3, max_pixels=25_000)
        assert result["stride"] > 1
        assert result["pixels_sampled"] < 700 * 700

    def test_caveats_are_returned(self):
        result = agronomy.management_zones(self._three_band_field(), n_zones=2)
        assert any("not a soil survey" in caveat or "descriptive" in caveat for caveat in result["caveats"])

    def test_a_non_2d_array_is_rejected(self):
        with pytest.raises(ValueError):
            agronomy.management_zones(np.zeros((3, 3, 3), dtype="float32"))


# --------------------------------------------------------------------------- #
# variable-rate prescription
# --------------------------------------------------------------------------- #
class TestPrescription:
    ZONES = [
        {"zone": 0, "name": "Zone 1 (weakest)", "index_mean": 0.30, "share_pct": 30.0},
        {"zone": 1, "name": "Zone 2", "index_mean": 0.55, "share_pct": 45.0},
        {"zone": 2, "name": "Zone 3 (strongest)", "index_mean": 0.80, "share_pct": 25.0},
    ]

    def test_weak_zones_get_more_and_strong_zones_get_less(self):
        result = agronomy.variable_rate_prescription(self.ZONES, product="nitrogen", base_rate=100.0, target_index=0.60)
        assert result["verdict"] == "ok"
        rates = {row["zone"]: row["rate"] for row in result["rows"]}
        assert rates[0] > 100.0
        assert rates[2] < 100.0
        assert result["rows"][0]["direction"] == "increase"

    def test_a_zone_at_target_holds_the_base_rate(self):
        result = agronomy.variable_rate_prescription(
            [{"zone": 0, "index_mean": 0.60, "share_pct": 100.0}], base_rate=180.0, product="N", target_index=0.60
        )
        assert result["rows"][0]["rate"] == 180.0
        assert result["rows"][0]["direction"] == "hold"

    def test_clamping_is_applied_and_flagged(self):
        result = agronomy.variable_rate_prescription(
            [{"zone": 0, "index_mean": 0.05, "share_pct": 100.0}],
            product="nitrogen",
            base_rate=100.0,
            target_index=0.60,
            min_rate=50.0,
            max_rate=120.0,
            response_per_index=3.0,
        )
        row = result["rows"][0]
        assert row["rate"] == 120.0
        assert row["clamped"] is True
        assert row["unclamped_rate"] > 120.0

    def test_the_plan_is_compared_against_a_flat_rate(self):
        result = agronomy.variable_rate_prescription(self.ZONES, product="N", base_rate=100.0, target_index=0.60)
        assert "vs_flat_rate" in result
        assert result["vs_flat_rate"]["direction"] in {"increase", "reduce", "hold"}
        assert result["area_weighted_rate"] > 0

    def test_a_zero_target_is_rejected(self):
        with pytest.raises(ValueError):
            agronomy.variable_rate_prescription(self.ZONES, product="N", base_rate=100.0, target_index=0.0)

    def test_a_non_positive_base_rate_is_rejected(self):
        with pytest.raises(ValueError):
            agronomy.variable_rate_prescription(self.ZONES, product="N", base_rate=0.0, target_index=0.5)

    def test_no_zones_reports_insufficient_data(self):
        result = agronomy.variable_rate_prescription([{"zone": 0, "index_mean": None}], product="N", base_rate=10, target_index=0.5)
        assert result["verdict"] == "insufficient_data"


# --------------------------------------------------------------------------- #
# soil carbon screening
# --------------------------------------------------------------------------- #
class TestCarbonScreen:
    def test_regenerative_practices_outperform_conventional(self):
        values = list(np.linspace(0.3, 0.8, 200))
        good = agronomy.soil_carbon_screening(values, tillage="no_till", cover_crop=True, residue_retained=True)
        bad = agronomy.soil_carbon_screening(values, tillage="conventional", cover_crop=False, residue_retained=False)
        assert good["estimate_t_c_per_ha_per_year"]["central"] > bad["estimate_t_c_per_ha_per_year"]["central"]
        assert good["trajectory"] == "gaining"
        assert bad["trajectory"] == "losing"

    def test_the_result_is_a_range_not_a_point_estimate(self):
        result = agronomy.soil_carbon_screening([0.4] * 100, tillage="no_till")
        band = result["estimate_t_c_per_ha_per_year"]
        assert band["low"] < band["central"] < band["high"]

    def test_it_declares_itself_not_mrv_grade(self):
        result = agronomy.soil_carbon_screening([0.4] * 100)
        assert result["verdict"] == "screening_estimate"
        assert "not MRV-grade" in result["verification"]["grade"]
        assert result["verification"]["missing_for_verification"], "it must list what is missing to verify"

    def test_saturation_limits_accrual_over_time(self):
        young = agronomy.soil_carbon_screening([0.5] * 100, tillage="no_till", cover_crop=True, years_in_practice=1)
        old = agronomy.soil_carbon_screening([0.5] * 100, tillage="no_till", cover_crop=True, years_in_practice=40)
        assert old["saturation_factor"] > young["saturation_factor"]
        assert old["saturation_factor"] < 1.0

    def test_practice_contributions_are_itemised(self):
        result = agronomy.soil_carbon_screening([0.5] * 50, tillage="no_till", cover_crop=True)
        names = [item["practice"] for item in result["contributions"]]
        assert "no-till" in names
        assert "cover crop" in names

    def test_no_valid_values_reports_insufficient_data(self):
        result = agronomy.soil_carbon_screening([float("nan"), float("nan")])
        assert result["verdict"] == "insufficient_data"


# --------------------------------------------------------------------------- #
# yield forecast
# --------------------------------------------------------------------------- #
class TestYieldForecast:
    SERIES = [0.2, 0.35, 0.5, 0.7, 0.8, 0.75, 0.6, 0.45]

    def test_an_uncalibrated_model_refuses_to_invent_a_tonnage(self):
        result = agronomy.yield_forecast(self.SERIES, crop="maize")
        assert result["verdict"] == "requires_calibration"
        assert "estimate" not in result
        assert result["index_integral"] == pytest.approx(sum(self.SERIES), rel=1e-6)
        assert len(result["how_to_calibrate"]) >= 3

    def test_a_calibrated_model_produces_an_estimate_and_a_band(self):
        result = agronomy.yield_forecast(
            self.SERIES, crop="maize", coefficient=2.0, intercept=1.0, calibration={"rmse": 0.4, "r_squared": 0.82, "n": 5}
        )
        assert result["verdict"] == "ok"
        expected = 1.0 + 2.0 * sum(self.SERIES)
        assert result["estimate"] == pytest.approx(expected, rel=1e-6)
        assert result["uncertainty"]["low"] == pytest.approx(expected - 0.4, rel=1e-6)
        assert result["uncertainty"]["basis"] == "calibration rmse"
        assert result["uncertainty"]["r_squared"] == 0.82

    def test_without_a_calibration_block_the_band_states_its_assumption(self):
        result = agronomy.yield_forecast(self.SERIES, coefficient=2.0, intercept=1.0)
        assert result["uncertainty"]["basis"] == "assumed 25% of the estimate"

    def test_nan_observations_are_dropped(self):
        result = agronomy.yield_forecast([0.5, float("nan"), 0.5], coefficient=1.0)
        assert result["observations"] == 2
        assert result["index_integral"] == pytest.approx(1.0)

    def test_empty_input_reports_insufficient_data(self):
        assert agronomy.yield_forecast([])["verdict"] == "insufficient_data"

    def test_it_never_claims_to_be_a_crop_simulation(self):
        result = agronomy.yield_forecast(self.SERIES, coefficient=2.0)
        assert any("not a process-based crop simulation" in caveat for caveat in result["caveats"])


# --------------------------------------------------------------------------- #
# disease risk
# --------------------------------------------------------------------------- #
class TestDiseaseRisk:
    def test_a_cool_wet_week_raises_wheat_rust_pressure(self):
        result = agronomy.disease_risk(
            tmin=[10.0] * 7, tmax=[16.0] * 7, humidity=[95.0] * 7, crop="wheat", rainfall=[3.0] * 7
        )
        yellow_rust = next(row for row in result["diseases"] if "Yellow" in row["disease"])
        assert yellow_rust["favourable_days"] == 7
        assert yellow_rust["longest_favourable_run_days"] == 7
        assert yellow_rust["level"] in {"high", "moderate"}

    def test_hot_dry_weather_suppresses_pressure(self):
        result = agronomy.disease_risk(
            tmin=[28.0] * 7, tmax=[38.0] * 7, humidity=[20.0] * 7, crop="wheat", rainfall=[0.0] * 7
        )
        assert result["highest_level"] in {"minimal", "low"}
        assert all(row["favourable_days"] == 0 for row in result["diseases"])

    def test_measured_leaf_wetness_overrides_the_humidity_proxy(self):
        result = agronomy.disease_risk(
            tmin=[15.0] * 5,
            tmax=[22.0] * 5,
            humidity=[40.0] * 5,          # dry air
            leaf_wetness_hours=[10.0] * 5,  # but wet leaves
            crop="wheat",
        )
        assert result["inputs"]["leaf_wetness_source"] == "measured"
        assert any(row["favourable_days"] > 0 for row in result["diseases"])
        assert all(row["rule"]["wetness_basis"].startswith("measured") for row in result["diseases"])

    def test_isolated_favourable_days_score_lower_than_a_run(self):
        scattered = agronomy.disease_risk(
            tmin=[10.0, 30.0, 10.0, 30.0, 10.0, 30.0], tmax=[16.0, 36.0, 16.0, 36.0, 16.0, 36.0],
            humidity=[95.0] * 6, rainfall=[3.0] * 6, crop="wheat",
        )
        consecutive = agronomy.disease_risk(
            tmin=[10.0, 10.0, 10.0, 30.0, 30.0, 30.0], tmax=[16.0, 16.0, 16.0, 36.0, 36.0, 36.0],
            humidity=[95.0] * 6, rainfall=[3.0] * 6, crop="wheat",
        )
        pick = lambda output: next(  # noqa: E731
            row["favourability_index"] for row in output["diseases"] if "Yellow" in row["disease"]
        )
        assert pick(consecutive) > pick(scattered), "run length must drive risk, not just the day count"

    def test_it_is_explicitly_not_a_diagnosis(self):
        result = agronomy.disease_risk([12.0], [20.0], [90.0], crop="potato")
        assert result["verdict"] == "weather_favourability — not a diagnosis"
        assert any("cannot see a lesion" in caveat for caveat in result["caveats"])
        assert result["next_action"]

    def test_crop_specific_rules_are_used(self):
        wheat = agronomy.disease_risk([15.0], [25.0], [90.0], crop="wheat")
        potato = agronomy.disease_risk([15.0], [25.0], [90.0], crop="potato")
        assert {row["disease"] for row in wheat["diseases"]} != {row["disease"] for row in potato["diseases"]}
        assert any(row["pathogen"] == "Phytophthora infestans" for row in potato["diseases"])

    def test_an_unknown_crop_falls_back_to_the_generic_rules(self):
        result = agronomy.disease_risk([15.0], [25.0], [90.0], crop="quinoa")
        assert result["crop"] == "quinoa"
        assert len(result["diseases"]) == 1

    def test_diseases_are_ranked_by_index(self):
        result = agronomy.disease_risk([1.0] * 3, [30.0] * 3, [95.0] * 3, crop="potato", rainfall=[2.0] * 3)
        scores = [row["favourability_index"] for row in result["diseases"]]
        assert scores == sorted(scores, reverse=True)

    def test_mismatched_input_lengths_are_rejected(self):
        with pytest.raises(ValueError):
            agronomy.disease_risk([10.0], [20.0], [90.0, 90.0])
        with pytest.raises(ValueError):
            agronomy.disease_risk([10.0], [20.0], [90.0], leaf_wetness_hours=[1.0, 2.0])


# --------------------------------------------------------------------------- #
# catalogue
# --------------------------------------------------------------------------- #
def test_the_catalogue_documents_every_model_with_a_confidence_level():
    catalogue = agronomy.model_catalogue()
    ids = {entry["id"] for entry in catalogue}
    assert ids == {"thermal_time", "water_balance", "management_zones", "variable_rate", "soil_carbon", "yield_forecast", "disease_risk"}
    for entry in catalogue:
        assert entry["confidence"], f"{entry['id']} must state how much it can be trusted"
        assert entry["outputs"] and entry["needs"]
