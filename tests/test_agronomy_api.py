"""API tests for the agronomy engine and the security posture endpoint.

These drive the real FastAPI app over HTTP so they also cover the Pydantic
validation layer: every endpoint must reject nonsense rather than pass it
through to the engine.
"""
from __future__ import annotations

import pytest


# --------------------------------------------------------------------------- #
# catalogue
# --------------------------------------------------------------------------- #
def test_the_model_catalogue_lists_every_model_with_its_confidence(client):
    body = client.get("/api/agronomy/models").json()
    ids = {entry["id"] for entry in body["models"]}
    assert {"thermal_time", "water_balance", "management_zones", "variable_rate", "soil_carbon", "yield_forecast", "disease_risk"} <= ids
    assert "maize" in body["crop_coefficients"]
    assert body["soil_water_holding_mm_per_m"]["loam"] > body["soil_water_holding_mm_per_m"]["sand"]
    for entry in body["models"]:
        assert entry["confidence"], f"{entry['id']} must declare how far it can be trusted"


# --------------------------------------------------------------------------- #
# thermal time
# --------------------------------------------------------------------------- #
def test_thermal_time_returns_gdd_and_a_stage(client):
    response = client.post(
        "/api/agronomy/thermal-time",
        json={"tmin": [10.0] * 30, "tmax": [24.0] * 30, "base_c": 10.0, "upper_c": 30.0, "method": "average", "crop": "maize"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == pytest.approx(30 * 7.0)
    assert body["phenology"]["crop"] == "maize"
    assert body["phenology"]["stage"] in {"initial", "development", "mid_season", "late_season"}
    assert body["phenology"]["caveat"]


def test_thermal_time_accepts_local_stage_lengths(client):
    body = client.post(
        "/api/agronomy/thermal-time",
        json={"tmin": [12.0], "tmax": [22.0], "crop": "wheat", "stage_days": [10, 10, 10, 10]},
    ).json()
    assert body["phenology"]["coefficients_used"]["stage_days"] == [10, 10, 10, 10]


def test_thermal_time_rejects_mismatched_series(client):
    """An engine ValueError must reach the client as a 400, not a 500."""
    response = client.post("/api/agronomy/thermal-time", json={"tmin": [10.0, 11.0], "tmax": [20.0]})
    assert response.status_code == 400, response.text
    body = response.json()
    assert body["status"] == 400
    assert body["error"] == "DataError"
    assert "length" in body["detail"].lower()


def test_thermal_time_rejects_an_impossible_base_temperature(client):
    response = client.post("/api/agronomy/thermal-time", json={"tmin": [10.0], "tmax": [20.0], "base_c": 90.0})
    assert response.status_code == 422  # Pydantic bound (le=40)


# --------------------------------------------------------------------------- #
# water balance
# --------------------------------------------------------------------------- #
def test_water_balance_schedules_irrigation_for_a_dry_month(client):
    body = client.post(
        "/api/agronomy/water-balance",
        json={"et0": [6.0] * 30, "rainfall": [0.0] * 30, "crop": "maize", "soil": "loam"},
    ).json()
    assert body["irrigation_total_mm"] > 0
    assert body["event_count"] >= 1
    assert "FAO-56" in body["method"]
    assert body["caveats"]


def test_water_balance_scales_with_soil_texture(client):
    sand = client.post("/api/agronomy/water-balance", json={"et0": [5.0], "rainfall": [0.0], "soil": "sand"}).json()
    clay = client.post("/api/agronomy/water-balance", json={"et0": [5.0], "rainfall": [0.0], "soil": "clay"}).json()
    assert clay["taw_mm"] > sand["taw_mm"]


def test_water_balance_rejects_an_out_of_range_efficiency(client):
    response = client.post(
        "/api/agronomy/water-balance",
        json={"et0": [5.0], "rainfall": [0.0], "irrigation_efficiency": 1.5},
    )
    assert response.status_code == 422


# --------------------------------------------------------------------------- #
# management zones
# --------------------------------------------------------------------------- #
def test_zones_run_on_the_scene_and_report_area(client, scene):
    response = client.post(
        "/api/agronomy/zones",
        json={"dataset": scene["raster"], "aoi": scene["aoi"], "index": "NDVI", "n_zones": 3},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["verdict"] == "ok"
    assert body["index"] == "NDVI"
    assert len(body["zones"]) == 3
    means = [zone["index_mean"] for zone in body["zones"]]
    assert means == sorted(means)
    assert all(zone.get("area_ha") for zone in body["zones"])
    assert body["warnings"] is not None
    # A full raster must not be serialised into the response body.
    assert "zone_map" not in body


def test_zones_accept_more_index_families(client, scene):
    # SAVI needs only red + NIR, which the synthetic scene provides.
    body = client.post(
        "/api/agronomy/zones",
        json={"dataset": scene["raster"], "aoi": scene["aoi"], "index": "SAVI", "n_zones": 2},
    ).json()
    assert body["verdict"] == "ok"
    assert body["index"] == "SAVI"


def test_zones_reject_an_out_of_range_zone_count(client, scene):
    response = client.post(
        "/api/agronomy/zones",
        json={"dataset": scene["raster"], "index": "NDVI", "n_zones": 99},
    )
    assert response.status_code == 422


def test_zones_report_a_missing_band_rather_than_guessing(client, scene):
    # NDMI needs SWIR1, which the synthetic 4-band scene does not carry.
    response = client.post(
        "/api/agronomy/zones",
        json={"dataset": scene["raster"], "aoi": scene["aoi"], "index": "NDMI"},
    )
    assert response.status_code == 400
    assert "swir1" in response.json()["detail"].lower()


def test_zones_on_an_unknown_dataset_is_a_clean_error(client):
    response = client.post("/api/agronomy/zones", json={"dataset": "nope.tif", "index": "NDVI"})
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# prescription
# --------------------------------------------------------------------------- #
def test_prescription_is_built_from_a_zone_table(client):
    response = client.post(
        "/api/agronomy/prescription",
        json={
            "zones": [
                {"zone": 0, "name": "Zone 1 (weakest)", "index_mean": 0.32, "share_pct": 40.0},
                {"zone": 1, "name": "Zone 2 (strongest)", "index_mean": 0.74, "share_pct": 60.0},
            ],
            "product": "nitrogen",
            "base_rate": 150.0,
            "target_index": 0.60,
            "rate_unit": "kg/ha",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["verdict"] == "ok"
    assert body["product"] == "nitrogen"
    rates = {row["zone"]: row["rate"] for row in body["rows"]}
    assert rates[0] > rates[1]
    assert body["vs_flat_rate"]["direction"] in {"increase", "reduce", "hold"}
    assert body["caveats"]


def test_prescription_rejects_a_zero_target(client):
    response = client.post(
        "/api/agronomy/prescription",
        json={"zones": [{"zone": 0, "index_mean": 0.5}], "base_rate": 100.0, "target_index": 0.0},
    )
    assert response.status_code == 400


def test_prescription_requires_at_least_one_zone(client):
    response = client.post(
        "/api/agronomy/prescription",
        json={"zones": [], "base_rate": 100.0, "target_index": 0.6},
    )
    assert response.status_code == 422


# --------------------------------------------------------------------------- #
# carbon + yield + disease
# --------------------------------------------------------------------------- #
def test_carbon_screen_declares_its_limited_verification(client):
    body = client.post(
        "/api/agronomy/carbon",
        json={"index_values": [0.4, 0.55, 0.6, 0.3] * 25, "tillage": "no_till", "cover_crop": True, "years_in_practice": 5},
    ).json()
    assert body["verdict"] == "screening_estimate"
    assert "not MRV-grade" in body["verification"]["grade"]
    assert body["verification"]["missing_for_verification"]
    assert body["estimate_t_c_per_ha_per_year"]["low"] < body["estimate_t_c_per_ha_per_year"]["high"]


def test_yield_forecast_refuses_to_invent_a_tonnage_without_calibration(client):
    body = client.post("/api/agronomy/yield-forecast", json={"index_series": [0.3, 0.5, 0.7, 0.6]}).json()
    assert body["verdict"] == "requires_calibration"
    assert "estimate" not in body
    assert body["how_to_calibrate"]


def test_yield_forecast_returns_a_band_when_calibrated(client):
    body = client.post(
        "/api/agronomy/yield-forecast",
        json={"index_series": [0.3, 0.5, 0.7], "coefficient": 3.0, "intercept": 2.0, "calibration": {"rmse": 0.5, "r_squared": 0.9, "n": 6}},
    ).json()
    assert body["verdict"] == "ok"
    assert body["uncertainty"]["r_squared"] == 0.9
    assert body["uncertainty"]["low"] < body["estimate"] < body["uncertainty"]["high"]


def test_disease_risk_is_labelled_a_favourability_index_not_a_diagnosis(client):
    body = client.post(
        "/api/agronomy/disease-risk",
        json={"tmin": [11.0] * 7, "tmax": [17.0] * 7, "humidity": [95.0] * 7, "rainfall": [3.0] * 7, "crop": "wheat"},
    ).json()
    assert "not a diagnosis" in body["verdict"]
    assert body["diseases"]
    assert body["diseases"] == sorted(body["diseases"], key=lambda row: row["favourability_index"], reverse=True)
    assert body["next_action"]


def test_disease_risk_rejects_mismatched_input_lengths(client):
    response = client.post(
        "/api/agronomy/disease-risk",
        json={"tmin": [10.0], "tmax": [20.0], "humidity": [80.0, 80.0]},
    )
    assert response.status_code == 400


# --------------------------------------------------------------------------- #
# security posture
# --------------------------------------------------------------------------- #
def test_security_posture_reports_what_is_wired_in(client):
    body = client.get("/api/security").json()
    assert "Content-Security-Policy" in body["headers"]
    assert "X-Frame-Options" in body["headers"]
    assert body["policy"]["frameAncestors"] == "none"
    assert body["policy"]["objectSrc"] == "none"
    assert "analysis" in body["classification"]
    assert body["uploadLimitMb"] == 8  # the suite overrides the default
    assert body["extensionAllowLists"]["raster"]
    # The missing authentication must be stated, not glossed over.
    assert "No user authentication" in body["note"]
    assert "reverse proxy" in body["note"]
