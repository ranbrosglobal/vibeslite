"""Real weather tests (Open-Meteo archive + forecast, NASA POWER).

The three providers are live third-party services, so nothing here touches the
network. Two seams are replaced:

* ``weather._http_json`` - the only place a provider request is made;
* ``weather._today`` - so "any date" logic (the archive stopping at today, the
  horizon, which days are provisional) is exercised deterministically rather
  than against whatever day the suite happens to run.

The stub reproduces the provider shapes and quirks measured against the live
endpoints, because those are what the module has to survive:

* the archive carries all 17 daily variables, the forecast endpoint only 14
  (no daily mean temperature, no daily mean wind, no soil moisture);
* the forecast endpoint answers ``past_days`` up to yesterday and
  ``forecast_days`` from today, and its last day comes back entirely null;
* NASA POWER marks unprocessed days with its -999 fill, and its ``WD10M`` is
  out of range across the whole record while ``U10M``/``V10M`` are sound;
* NASA POWER's ``ALLSKY_SFC_SW_DWN`` is fill for every day.

What matters under test is therefore the logic that decides what a number *is*:
which day came from which provider, which totals may include it, and that a day
nobody reported stays null instead of being invented.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

import pytest

import weather

# The suite's "now": every window below is expressed relative to it.
TODAY = date(2026, 6, 30)

#: Real values taken from a live archive response, one per variable.
TEMPLATE: Dict[str, float] = {
    "temperature_2m_max": 26.1,
    "temperature_2m_min": 18.6,
    "temperature_2m_mean": 21.5,
    "relative_humidity_2m_mean": 82.0,
    "dew_point_2m_mean": 18.2,
    "precipitation_sum": 1.6,
    "rain_sum": 1.6,
    "wind_speed_10m_max": 22.2,
    "wind_speed_10m_mean": 12.1,
    "wind_gusts_10m_max": 46.8,
    "wind_direction_10m_dominant": 264.0,
    "shortwave_radiation_sum": 27.31,
    "et0_fao_evapotranspiration": 4.77,
    "cloud_cover_mean": 40.0,
    "pressure_msl_mean": 1018.8,
    "soil_moisture_0_to_7cm_mean": 0.127,
    "soil_temperature_0_to_7cm_mean": 23.8,
}
#: The forecast endpoint serves this subset; asking for the rest returns nothing.
FORECAST_SERVED = [key for key in TEMPLATE if key not in set(weather.FORECAST_DAILY_UNAVAILABLE)]

POWER_TEMPLATE: Dict[str, float] = {
    "T2M": 21.2,
    "T2M_MAX": 25.4,
    "T2M_MIN": 17.9,
    "T2MDEW": 17.4,
    "RH2M": 80.5,
    "WS10M": 3.4,
    "PRECTOTCORR": 1.1,
    "GWETTOP": 0.44,
    "CLOUD_AMT": 42.0,
    "PS": 101.3,
    "U10M": 0.56,
    "V10M": -7.54,
}
FILL = -999.0


# --------------------------------------------------------------------------- #
# the stub provider
# --------------------------------------------------------------------------- #
class Stub:
    """Stands in for the three providers, reproducing their measured shapes."""

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.archive_nulls: set[str] = set()
        self.forecast_nulls: set[str] = set()
        self.forecast_extra_nulls: set[str] = set()
        self.power_fill_tail: int = 0
        self.power_days: Optional[List[date]] = None

    # ---- recording ------------------------------------------------------ #
    def requests(self, provider: str) -> List[Dict[str, Any]]:
        return [call for call in self.calls if call["provider"] == provider]

    # ---- payload builders ---------------------------------------------- #
    def _meteo_daily(self, days: Sequence[date], variables: Iterable[str], nulls: set[str]) -> Dict[str, Any]:
        daily: Dict[str, Any] = {"time": [day.isoformat() for day in days]}
        for key in variables:
            base = TEMPLATE[key]
            # Three decimals, like the real payload: soil moisture arrives as
            # 0.127 m3/m3 and rounding it to two would hide a mapping bug.
            daily[key] = [
                None if day.isoformat() in nulls else round(base + (day - days[0]).days * 0.1, 3)
                for day in days
            ]
        return daily

    def _archive(self, params: Mapping[str, Any]) -> Dict[str, Any]:
        start = date.fromisoformat(params["start_date"])
        end = date.fromisoformat(params["end_date"])
        days = [start + timedelta(days=offset) for offset in range((end - start).days + 1)]
        variables = [key for key in str(params["daily"]).split(",") if key]
        return {
            "latitude": params["latitude"],
            "longitude": params["longitude"],
            "timezone": "UTC",
            "daily": self._meteo_daily(days, variables, set(self.archive_nulls)),
        }

    def _forecast(self, params: Mapping[str, Any]) -> Dict[str, Any]:
        back = int(params.get("past_days") or 0)
        forward = int(params.get("forecast_days") or 0)
        days: List[date] = []
        if back:
            days += [TODAY - timedelta(days=offset) for offset in range(back, 0, -1)]
        if forward:
            days += [TODAY + timedelta(days=offset) for offset in range(forward)]
        variables = [key for key in str(params["daily"]).split(",") if key]
        nulls = set(self.forecast_nulls) | set(self.forecast_extra_nulls)
        # Measured edge: the provider accepts 16 forecast days but answers the
        # last one (today + 15) with nulls in every field. It is not "the last
        # day of whatever you asked for" - a 3-day request comes back full.
        edge = (TODAY + timedelta(days=weather.FORECAST_HORIZON_DAYS)).isoformat()
        if edge in {day.isoformat() for day in days}:
            nulls = nulls | {edge}
        body: Dict[str, Any] = {
            "timezone": "UTC",
            "daily": self._meteo_daily(days, variables, nulls),
        }
        if params.get("current"):
            body["current"] = {
                "time": f"{TODAY.isoformat()}T12:30",
                "interval": 900,
                "temperature_2m": 16.9,
                "apparent_temperature": 16.2,
                "relative_humidity_2m": 90.0,
                "dew_point_2m": 15.2,
                "precipitation": 0.4,
                "et0_fao_evapotranspiration": 0.03,
                "soil_moisture_0_to_1cm": 0.28,
                "soil_moisture_3_9cm": 0.366,
                "wind_speed_10m": 20.2,
                "wind_direction_10m": 210.0,
                "wind_gusts_10m": 37.1,
                "cloud_cover": 100.0,
                "pressure_msl": 1004.2,
                "shortwave_radiation": 205.0,
            }
        return body

    def _power(self, params: Mapping[str, Any]) -> Dict[str, Any]:
        start = date.fromisoformat(
            f"{params['start'][:4]}-{params['start'][4:6]}-{params['start'][6:]}"
        )
        end = date.fromisoformat(f"{params['end'][:4]}-{params['end'][4:6]}-{params['end'][6:]}")
        days = self.power_days or [
            start + timedelta(days=offset) for offset in range((end - start).days + 1)
        ]
        stamps = [day.strftime("%Y%m%d") for day in days]
        filled = set(stamps[len(stamps) - self.power_fill_tail :]) if self.power_fill_tail else set()

        def series(key: str, fill_value: float = FILL, transform=None) -> Dict[str, Any]:
            out: Dict[str, Any] = {}
            for index, stamp in enumerate(stamps):
                value = None if stamp in filled else round(POWER_TEMPLATE[key] + index * 0.1, 2)
                if value is None:
                    out[stamp] = fill_value
                else:
                    out[stamp] = transform(value) if transform else value
            return out

        parameters = {key: series(key) for key in ("T2M", "T2M_MAX", "T2M_MIN", "T2MDEW", "RH2M",
                                                   "WS10M", "PRECTOTCORR", "GWETTOP", "CLOUD_AMT", "PS",
                                                   "U10M", "V10M")}
        # Measured quirk: out of range for every day of every window tried.
        parameters["WD10M"] = {stamp: -5443.0 - index * 110 for index, stamp in enumerate(stamps)}
        # Measured quirk: present in the catalogue, fill in answers.
        parameters["ALLSKY_SFC_SW_DWN"] = {stamp: FILL for stamp in stamps}
        return {
            "header": {"fill_value": FILL, "title": "NASA POWER Daily API"},
            "properties": {"parameter": parameters},
        }

    def __call__(self, url: str, *, provider: str, cfg: Mapping[str, Any], params: Mapping[str, Any] | None = None) -> Any:
        params = dict(params or {})
        kind = "archive" if url == cfg["archive_url"] else "forecast" if url == cfg["forecast_url"] else "power"
        self.calls.append({"provider": provider, "url": url, "params": params, "kind": kind})
        if kind == "archive":
            return self._archive(params)
        if kind == "forecast":
            return self._forecast(params)
        return self._power(params)


@pytest.fixture()
def stub(monkeypatch) -> Stub:
    """Install the stub and freeze 'today' so window logic is deterministic."""
    fake = Stub()
    monkeypatch.setattr(weather, "_http_json", fake)
    monkeypatch.setattr(weather, "_today", lambda: TODAY)
    weather._reset_cache()
    yield fake
    weather._reset_cache()


def window(start_offset: int, end_offset: int) -> tuple[str, str]:
    """A date window relative to the frozen today."""
    return (
        (TODAY + timedelta(days=start_offset)).isoformat(),
        (TODAY + timedelta(days=end_offset)).isoformat(),
    )


# --------------------------------------------------------------------------- #
# catalogue
# --------------------------------------------------------------------------- #
def test_catalogue_names_the_real_providers_and_licences(stub):
    cat = weather.catalogue()
    ids = [provider["id"] for provider in cat["providers"]]
    assert ids == ["open-meteo-archive", "open-meteo-forecast", "nasa-power"]
    assert cat["coverage"]["archive_from"] == "1940-01-01"
    assert all(provider["auth"] == "none" for provider in cat["providers"])
    assert all(provider["licence"] and provider["attribution"] for provider in cat["providers"])
    assert "Copernicus" in cat["providers"][0]["licence"]


def test_catalogue_records_windy_as_the_map_and_never_as_a_source(stub):
    """The split is recorded: Windy draws the map, the archive answers the numbers."""
    cat = weather.catalogue()
    entry = next(item for item in cat["not_used"] if item["id"] == "windy-point-forecast")
    assert "not possible to retrieve historical forecasts" in entry["reason"]
    assert entry["source"].startswith("https://api.windy.com/")

    # It is not absent from the product though - it is the map, and says so.
    windy = next(item for item in cat["maps"] if item["id"] == "windy")
    assert windy["role"] == "visualisation"
    assert windy["kind"] == "forecast-map"
    assert windy["archive"] is False, "Windy has no archive, so its map is live-only"
    assert "no archive" in windy["note"]
    assert windy["endpoint"] == "https://embed.windy.com/embed2.html"
    for overlay in ("wind", "rain", "temp"):
        assert overlay in windy["overlays"]
    # The one thing a map must never do is imply it can answer for a past date.
    assert "never show a past date" in windy["note"]


def test_catalogue_states_the_real_parameter_names(stub):
    cat = weather.catalogue()
    units = cat["units"]
    assert units["temperature_max_c"] == "degC"
    assert units["soil_moisture_m3_m3"] == "m3/m3"
    assert "et0_mm" in units and "wind_direction_deg" in units


# --------------------------------------------------------------------------- #
# request shaping - this is what makes the code work against the live services
# --------------------------------------------------------------------------- #
def test_archive_is_asked_for_every_variable_it_actually_serves(stub):
    weather.daily(52.53, 5.55, *window(-40, -34))
    call = stub.requests("Open-Meteo archive")[0]
    assert call["url"].endswith("/v1/archive")
    asked = set(str(call["params"]["daily"]).split(","))
    assert asked == set(weather.METEO_DAILY_FIELDS)
    assert call["params"]["timezone"] == "UTC"


def test_forecast_is_never_asked_for_variables_it_does_not_serve(stub):
    weather.daily(52.53, 5.55, *window(-2, 3))
    calls = stub.requests("Open-Meteo forecast")
    assert calls, "the forecast endpoint has to be consulted for recent and future days"
    for call in calls:
        asked = set(str(call["params"]["daily"]).split(","))
        assert asked.isdisjoint(weather.FORECAST_DAILY_UNAVAILABLE)
        assert int(call["params"]["forecast_days"]) <= weather.FORECAST_HORIZON_DAYS
        assert int(call["params"]["past_days"]) <= weather.FORECAST_PAST_DAYS_MAX


def test_archive_is_never_asked_for_a_date_after_today(stub):
    """The live endpoint rejects end_date past today with HTTP 400."""
    weather.daily(52.53, 5.55, *window(-5, 5))
    for call in stub.requests("Open-Meteo archive"):
        assert date.fromisoformat(call["params"]["end_date"]) <= TODAY


def test_equivalent_requests_hit_the_cache_instead_of_the_provider(monkeypatch):
    """Caching lives inside the real HTTP seam, so it is exercised there."""
    import io
    import json as jsonlib
    import urllib.request

    calls = {"n": 0}
    body = jsonlib.dumps({"daily": {"time": ["2026-06-20"], "temperature_2m_max": [20.0]}}).encode()

    class Response(io.BytesIO):
        def __enter__(self):  # noqa: D105 - mirrors urlopen's context manager
            return self

        def __exit__(self, *exc):  # noqa: D105
            return False

    def fake_urlopen(request, timeout=None):  # noqa: ARG001
        calls["n"] += 1
        return Response(body)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    weather._reset_cache()
    cfg = weather.weather_config()
    first = weather._http_json("https://example.test/x", provider="stub", cfg=cfg, params={"a": 1})
    hits_before = weather.telemetry()["cache_hits"]
    second = weather._http_json("https://example.test/x", provider="stub", cfg=cfg, params={"a": 1})
    assert first == second == jsonlib.loads(body)
    assert calls["n"] == 1, "an identical URL must not be fetched twice"
    assert weather.telemetry()["cache_hits"] > hits_before
    weather._http_json("https://example.test/x", provider="stub", cfg=cfg, params={"a": 2})
    assert calls["n"] == 2, "a different query is a different entry"


# --------------------------------------------------------------------------- #
# daily: mapping, provenance, totals
# --------------------------------------------------------------------------- #
def test_daily_maps_every_archive_variable_to_its_canonical_field(stub):
    result = weather.daily(52.53, 5.55, *window(-40, -40))
    day = result["days"][0]
    assert day["temperature_max_c"] == TEMPLATE["temperature_2m_max"]
    assert day["temperature_min_c"] == TEMPLATE["temperature_2m_min"]
    assert day["temperature_mean_c"] == TEMPLATE["temperature_2m_mean"]
    assert day["humidity_mean_pct"] == TEMPLATE["relative_humidity_2m_mean"]
    assert day["precipitation_mm"] == TEMPLATE["precipitation_sum"]
    assert day["et0_mm"] == TEMPLATE["et0_fao_evapotranspiration"]
    assert day["shortwave_radiation_mj_m2"] == TEMPLATE["shortwave_radiation_sum"]
    assert day["soil_moisture_m3_m3"] == TEMPLATE["soil_moisture_0_to_7cm_mean"]
    assert day["wind_direction_deg"] == TEMPLATE["wind_direction_10m_dominant"]
    assert day["reported"] is True


def test_every_day_carries_its_own_source_and_kind(stub):
    result = weather.daily(52.53, 5.55, *window(-30, -20))
    assert all(day["kind"] == "reanalysis" for day in result["days"])
    assert all(day["source"] == "open-meteo-archive" for day in result["days"])
    assert all(day["provisional"] is False for day in result["days"])
    assert [p["source"] for p in result["provenance"]] == ["open-meteo-archive", "open-meteo-forecast"]


def test_summary_totals_match_the_days_it_reports(stub):
    result = weather.daily(52.53, 5.55, *window(-40, -34))
    summary = result["summary"]
    days = result["days"]
    assert summary["days_past"] == 7 and summary["days_ahead"] == 0
    assert summary["rain_sum_mm"] == pytest.approx(sum(day["precipitation_mm"] for day in days), abs=0.05)
    assert summary["et0_sum_mm"] == pytest.approx(sum(day["et0_mm"] for day in days), abs=0.05)
    assert summary["water_balance_mm"] == pytest.approx(
        summary["rain_sum_mm"] - summary["et0_sum_mm"], abs=0.05
    )
    assert summary["temperature_max_c"] == max(day["temperature_max_c"] for day in days)


def test_near_real_time_days_are_flagged_provisional(stub):
    result = weather.daily(52.53, 5.55, *window(-10, -1))
    assert all(day["provisional"] for day in result["days"])
    assert result["summary"]["days_provisional"] == 10
    assert any("preliminary stream" in warning for warning in result["warnings"])


def test_settled_days_are_not_flagged_provisional(stub):
    result = weather.daily(52.53, 5.55, *window(-60, -50))
    assert not any(day["provisional"] for day in result["days"])
    assert result["summary"]["days_provisional"] == 0


def test_forecast_days_are_never_added_to_a_past_total(stub):
    """A prediction must not be summed into a measurement."""
    past_end, future_end = window(-3, 2)
    result = weather.daily(52.53, 5.55, past_end, future_end)
    kinds = {day["date"]: day["kind"] for day in result["days"]}
    assert kinds[future_end] == "forecast"
    assert result["summary"]["days_ahead"] == 2
    assert result["summary"]["days_past"] == 4
    past_rain = sum(
        day["precipitation_mm"] for day in result["days"] if day["kind"] != "forecast"
    )
    assert result["summary"]["rain_sum_mm"] == pytest.approx(past_rain, abs=0.05)


def test_a_purely_future_window_has_forecast_days_and_no_totals(stub):
    result = weather.daily(52.53, 5.55, *window(1, 4))
    assert all(day["kind"] == "forecast" for day in result["days"])
    assert all(day["source"] == "open-meteo-forecast" for day in result["days"])
    assert result["summary"]["days_past"] == 0
    assert result["summary"]["rain_sum_mm"] is None
    assert result["summary"]["water_balance_mm"] is None


def test_days_beyond_the_horizon_are_missing_not_estimated(stub):
    result = weather.daily(52.53, 5.55, (TODAY + timedelta(days=10)).isoformat(),
                           (TODAY + timedelta(days=20)).isoformat())
    assert result["summary"]["days_missing"] > 0
    beyond = [day for day in result["days"] if date.fromisoformat(day["date"]) > TODAY + timedelta(days=14)]
    assert beyond and all(day["reported"] is False for day in beyond)
    assert all(day["temperature_max_c"] is None for day in beyond)
    assert any("beyond the" in warning for warning in result["warnings"])


def test_the_promised_horizon_is_the_horizon_that_carries_data(stub):
    """No day inside the published horizon may come back empty from the provider."""
    result = weather.daily(52.53, 5.55, TODAY.isoformat(),
                           (TODAY + timedelta(days=weather.FORECAST_HORIZON_DAYS - 1)).isoformat())
    assert result["summary"]["days_missing"] == 0
    assert result["summary"]["days_reported"] == weather.FORECAST_HORIZON_DAYS
    assert weather.catalogue()["coverage"]["forecast_to"] == (
        f"today + {weather.FORECAST_HORIZON_DAYS - 1} days"
    )


def test_a_gap_no_source_can_fill_stays_null_and_is_named(stub):
    """A gap is counted and named, never interpolated from its neighbours.

    The day is far enough back that the forecast endpoint's 92-day reach
    cannot cover it either, so it is genuinely unanswerable - and the answer
    has to say so rather than invent a number.
    """
    hole = (TODAY - timedelta(days=200)).isoformat()
    stub.archive_nulls = {hole}
    result = weather.daily(52.53, 5.55, (TODAY - timedelta(days=202)).isoformat(),
                           (TODAY - timedelta(days=198)).isoformat())
    day = next(row for row in result["days"] if row["date"] == hole)
    assert day["reported"] is False
    assert day["temperature_max_c"] is None
    assert day["precipitation_mm"] is None
    assert result["summary"]["days_missing"] == 1
    assert result["summary"]["rain_sum_mm"] is not None, "the other days still total"
    assert any(hole in warning and "no source" in warning for warning in result["warnings"])


def test_an_unreported_archive_day_is_filled_from_the_forecast_model_and_labelled(stub):
    unpublished = (TODAY - timedelta(days=4)).isoformat()
    stub.archive_nulls = {unpublished}
    result = weather.daily(52.53, 5.55, *window(-6, -1))
    filled = next(day for day in result["days"] if day["date"] == unpublished)
    assert filled["source"] == "open-meteo-forecast"
    assert filled["reported"] is True
    assert any("have already happened but the reanalysis archive has not published" in w
               for w in result["warnings"])


def test_a_null_field_is_never_published_as_zero(stub):
    """The provider's null edge must not become 0 mm of rain or 0 degrees."""
    blank = (TODAY + timedelta(days=2)).isoformat()
    stub.forecast_extra_nulls = {blank}
    result = weather.daily(52.53, 5.55, TODAY.isoformat(), blank)
    day = next(row for row in result["days"] if row["date"] == blank)
    assert day["precipitation_mm"] is None
    assert day["et0_mm"] is None
    assert day["reported"] is False
    assert result["summary"]["days_missing"] == 1


# --------------------------------------------------------------------------- #
# validation
# --------------------------------------------------------------------------- #
def test_dates_before_the_archive_are_refused_by_name(stub):
    with pytest.raises(weather.WeatherError) as excinfo:
        weather.daily(52.53, 5.55, "1939-12-30", "1940-01-02")
    assert "1940-01-01" in str(excinfo.value)


def test_start_after_end_is_refused(stub):
    with pytest.raises(weather.WeatherError):
        weather.daily(52.53, 5.55, "2026-06-10", "2026-06-01")


def test_a_window_longer_than_the_limit_is_refused(stub):
    with pytest.raises(weather.WeatherError) as excinfo:
        weather.daily(52.53, 5.55, "1990-01-01", "2026-01-01")
    assert "at most" in str(excinfo.value)


def test_a_window_entirely_beyond_the_horizon_is_refused(stub):
    with pytest.raises(weather.WeatherError) as excinfo:
        weather.daily(52.53, 5.55, (TODAY + timedelta(days=40)).isoformat(),
                      (TODAY + timedelta(days=45)).isoformat())
    assert "days ahead" in str(excinfo.value)


@pytest.mark.parametrize(
    "lat,lon",
    [(999, 5.5), (52.5, 999), (float("nan"), 5.5), (89.95, 5.5), ("north", 5.5)],
)
def test_invalid_coordinates_are_refused(stub, lat, lon):
    with pytest.raises(weather.WeatherError):
        weather.daily(lat, lon, *window(-10, -5))


def test_a_malformed_date_is_refused(stub):
    with pytest.raises(weather.WeatherError):
        weather.daily(52.53, 5.55, "last tuesday", "2026-06-30")


def test_disabled_configuration_is_refused(monkeypatch, stub):
    monkeypatch.setattr(weather, "weather_config", lambda: {"enabled": False})
    with pytest.raises(weather.WeatherDisabled) as excinfo:
        weather.daily(52.53, 5.55, *window(-10, -5))
    assert excinfo.value.status_code == 503


def test_provider_transport_errors_are_typed(monkeypatch, stub):
    def boom(url, *, provider, cfg, params=None):
        raise weather.WeatherUnavailable(f"{provider} could not be reached.")

    monkeypatch.setattr(weather, "_http_json", boom)
    weather._reset_cache()
    with pytest.raises(weather.WeatherUnavailable) as excinfo:
        weather.daily(52.53, 5.55, *window(-3, -1))
    assert excinfo.value.status_code == 503


# --------------------------------------------------------------------------- #
# for_dates: the join that dates an image
# --------------------------------------------------------------------------- #
def test_for_dates_matches_each_requested_date_one_to_one(stub):
    first, second = window(-20, -20), window(-13, -13)
    result = weather.for_dates(52.53, 5.55, [first[0], second[0]])
    assert result["requested"] == [first[0], second[0]]
    assert result["dates"] == [first[0], second[0]]
    assert [day["date"] for day in result["days"]] == [first[0], second[0]]
    assert result["missing"] == []


def test_for_dates_deduplicates_and_refuses_an_empty_list(stub):
    day = window(-20, -20)[0]
    result = weather.for_dates(52.53, 5.55, [day, day])
    assert result["dates"] == [day]
    with pytest.raises(weather.WeatherError):
        weather.for_dates(52.53, 5.55, [])


def test_for_dates_reports_a_date_it_cannot_answer(stub):
    requested = window(-20, -20)[0]
    result = weather.for_dates(52.53, 5.55, [requested, (TODAY + timedelta(days=40)).isoformat()])
    assert result["missing"] == [(TODAY + timedelta(days=40)).isoformat()]
    assert [day["date"] for day in result["days"]] == [requested]


def test_for_dates_fetches_only_the_span_it_needs(stub):
    start, _ = window(-20, -20)
    end, _ = window(-16, -16)
    weather.for_dates(52.53, 5.55, [start, end])
    call = stub.requests("Open-Meteo archive")[0]
    assert call["params"]["start_date"] == start
    assert call["params"]["end_date"] == end


# --------------------------------------------------------------------------- #
# current conditions
# --------------------------------------------------------------------------- #
def test_current_maps_the_live_block(stub):
    result = weather.current(52.53, 5.55)
    reading = result["current"]
    assert reading["temperature_c"] == 16.9
    assert reading["humidity_pct"] == 90.0
    assert reading["wind_speed_kmh"] == 20.2
    assert reading["wind_direction_deg"] == 210.0
    assert reading["wind_gusts_kmh"] == 37.1
    assert reading["et0_mm"] == 0.03
    assert reading["shortwave_radiation_w_m2"] == 205.0
    assert reading["observed_at"] == f"{TODAY.isoformat()}T12:30"
    assert reading["today"]["date"] == TODAY.isoformat()


def test_current_converts_soil_moisture_and_keeps_todays_totals(stub):
    reading = weather.current(52.53, 5.55)["current"]
    assert reading["soil_moisture_root_m3_m3"] == 0.366
    assert reading["soil_moisture_root_pct"] == 36.6
    assert reading["soil_moisture_surface_pct"] == 28.0


def test_current_treats_the_zero_fill_as_a_model_gap(stub, monkeypatch):
    """0 m3/m3 is Open-Meteo's fill value, not a bone-dry field."""
    original = Stub._forecast

    def zeroed(self, params):
        body = original(self, params)
        body["current"]["soil_moisture_3_9cm"] = 0
        body["current"]["soil_moisture_0_to_1cm"] = 0
        return body

    monkeypatch.setattr(Stub, "_forecast", zeroed)
    result = weather.current(52.53, 5.55)
    assert result["current"]["soil_moisture_root_m3_m3"] == 0.0
    assert result["current"]["soil_moisture_root_pct"] is None
    assert result["current"]["soil_moisture_surface_pct"] is None
    assert any("fill value" in warning for warning in result["warnings"])


# --------------------------------------------------------------------------- #
# NASA POWER: fill values, the broken parameter, the derived direction
# --------------------------------------------------------------------------- #
def test_power_fill_days_are_excluded_and_counted_never_averaged(stub):
    stub.power_fill_tail = 3
    result = weather.cross_check_daily(52.53, 5.55, *window(-14, -8))
    assert result["days_compared"] == 4
    assert result["skipped"]["nasa_power_fill_days"] == 3
    assert result["skipped"]["fill_value"] == FILL
    assert all(day["nasa_power"]["temperature_mean_c"] is not None for day in result["days"])


def test_power_out_of_range_wind_direction_is_rejected_and_named(stub):
    result = weather.cross_check_daily(52.53, 5.55, *window(-14, -8))
    rejected = result["rejected"][0]
    assert rejected["parameter"] == "WD10M"
    assert rejected["usable_values"] == 0
    assert rejected["sample"] < -360
    assert any("WD10M" in warning for warning in result["warnings"])


def test_power_radiation_that_is_all_fill_is_reported_unavailable(stub):
    result = weather.cross_check_daily(52.53, 5.55, *window(-14, -8))
    assert [item["parameter"] for item in result["unavailable"]] == ["ALLSKY_SFC_SW_DWN"]
    assert any("ALLSKY_SFC_SW_DWN" in warning for warning in result["warnings"])


def test_direction_is_derived_from_the_components(stub):
    """The compass convention has to be right: wind FROM the north reads 0."""
    assert weather._direction_from_components(0.0, -7.54) == pytest.approx(0.0, abs=0.2)
    assert weather._direction_from_components(-5.0, 0.0) == pytest.approx(90.0, abs=0.2)
    assert weather._direction_from_components(0.0, 5.0) == pytest.approx(180.0, abs=0.2)
    assert weather._direction_from_components(5.0, 0.0) == pytest.approx(270.0, abs=0.2)
    assert weather._direction_from_components(0.0, 0.0) is None
    assert weather._direction_from_components(None, 3.0) is None


def test_cross_check_converts_power_units_before_comparing(stub):
    result = weather.cross_check_daily(52.53, 5.55, *window(-14, -8))
    first = result["days"][0]
    # POWER serves WS10M in m/s and PS in kPa; both are reported in the
    # canonical units so a comparison is like-for-like.
    assert first["nasa_power"]["wind_speed_mean_kmh"] == pytest.approx(3.4 * 3.6, abs=0.05)
    assert result["primary"]["mean_wind_kmh"] is not None


def test_cross_check_compares_only_days_both_report(stub):
    stub.power_fill_tail = 2
    result = weather.cross_check_daily(52.53, 5.55, *window(-14, -8))
    for day in result["days"]:
        assert day["open_meteo"]["temperature_mean_c"] is not None
        assert day["nasa_power"]["temperature_mean_c"] is not None
    assert result["days_compared"] == len(result["days"])


def test_cross_check_states_an_agreement_verdict(stub):
    result = weather.cross_check_daily(52.53, 5.55, *window(-14, -8))
    assert result["agreement"] in {"close", "divergent"}
    assert set(result["delta"]) == {"mean_temperature_c", "rain_sum_mm", "mean_humidity_pct", "mean_wind_kmh"}


def test_cross_check_needs_days_that_have_already_happened(stub):
    with pytest.raises(weather.WeatherError) as excinfo:
        weather.cross_check_daily(52.53, 5.55, (TODAY + timedelta(days=1)).isoformat(),
                                  (TODAY + timedelta(days=3)).isoformat())
    assert "still ahead" in str(excinfo.value)


def test_cross_check_is_limited_to_the_power_window(stub):
    with pytest.raises(weather.WeatherError) as excinfo:
        weather.cross_check_daily(52.53, 5.55, "2024-01-01", "2026-01-01")
    assert "NASA POWER cross-checks are limited" in str(excinfo.value)


def test_daily_can_carry_the_cross_check(stub):
    result = weather.daily(52.53, 5.55, *window(-20, -14), cross_check=True)
    assert result["cross_check"]["days_compared"] == 7
    assert [p["source"] for p in result["provenance"]] == [
        "open-meteo-archive", "open-meteo-forecast", "nasa-power",
    ]


def test_power_days_outside_the_window_are_not_reported_as_days(stub):
    stub.power_days = [TODAY - timedelta(days=offset) for offset in range(20, 0, -1)]
    result = weather.cross_check_daily(52.53, 5.55, *window(-7, -1))
    assert len(result["days"]) == 7
    assert [day["date"] for day in result["days"]] == [
        (TODAY - timedelta(days=offset)).isoformat() for offset in range(7, 0, -1)
    ]


# --------------------------------------------------------------------------- #
# api surface
# --------------------------------------------------------------------------- #
def test_api_weather_endpoints_exist_and_are_wired(client, monkeypatch):
    """The HTTP layer must reach the engine, without touching a provider."""
    fake = Stub()
    monkeypatch.setattr(weather, "_http_json", fake)
    monkeypatch.setattr(weather, "_today", lambda: TODAY)
    weather._reset_cache()

    catalogue = client.get("/api/weather/catalogue")
    assert catalogue.status_code == 200
    assert catalogue.json()["coverage"]["any_date"] is True

    daily = client.get("/api/weather/daily", params={"lat": 52.53, "lon": 5.55, **dict(
        zip(("start", "end"), window(-30, -25))
    )})
    assert daily.status_code == 200, daily.text
    assert daily.json()["summary"]["days_past"] == 6

    current = client.get("/api/weather/current", params={"lat": 52.53, "lon": 5.55})
    assert current.status_code == 200
    assert current.json()["current"]["soil_moisture_root_pct"] == 36.6

    cross_start, cross_end = window(-10, -8)
    cross = client.get("/api/weather/crosscheck", params={"lat": 52.53, "lon": 5.55,
                                                          "start": cross_start, "end": cross_end})
    assert cross.status_code == 200, cross.text
    assert cross.json()["days_compared"] == 3

    for_dates = client.post("/api/weather/for-dates", json={
        "lat": 52.53, "lon": 5.55, "dates": [window(-20, -20)[0]],
    })
    assert for_dates.status_code == 200, for_dates.text
    assert for_dates.json()["dates"] == [window(-20, -20)[0]]


def test_api_weather_rejects_an_impossible_date_with_a_named_error(client, monkeypatch):
    monkeypatch.setattr(weather, "_http_json", Stub())
    monkeypatch.setattr(weather, "_today", lambda: TODAY)
    weather._reset_cache()
    response = client.get("/api/weather/daily", params={"lat": 52.53, "lon": 5.55,
                                                       "start": "1939-01-01", "end": "1939-02-01"})
    assert response.status_code == 400
    assert "1940-01-01" in response.json()["detail"]


def test_api_weather_validates_the_request_before_any_call(client, monkeypatch):
    fake = Stub()
    monkeypatch.setattr(weather, "_http_json", fake)
    weather._reset_cache()
    response = client.get("/api/weather/daily", params={"lat": 200, "lon": 5.55})
    assert response.status_code == 422
    assert fake.calls == []


def test_api_for_dates_needs_at_least_one_date(client, monkeypatch):
    monkeypatch.setattr(weather, "_http_json", Stub())
    response = client.post("/api/weather/for-dates", json={"lat": 52.5, "lon": 5.5, "dates": []})
    assert response.status_code == 422
