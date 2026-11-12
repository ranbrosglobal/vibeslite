"""OpenStreetMap provider tests (Nominatim search/reverse, Overpass features).

Nominatim and Overpass are live third-party services, so nothing here touches
the network: the single HTTP seam (``osm._fetch_json``) and the Overpass POST are
replaced with canned payloads. What is actually protected:

* validation happens **before** an upstream call, so a bad request never spends
  a public API call;
* the response shapes the frontend renders (place normalisation, GeoJSON
  conversion, counts, truncation);
* the one-request-per-second policy the Nominatim usage rules require;
* honest failure - unreachable provider is a 503, never a guessed coordinate;
* the CSP allowlist is derived from the basemap catalogue rather than retyped.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Tuple

import pytest

import config
import geospatial
import osm

ATTRIBUTION = "© OpenStreetMap contributors"


# --------------------------------------------------------------------------- #
# fixtures / helpers
# --------------------------------------------------------------------------- #
@pytest.fixture()
def fast_osm(monkeypatch):
    """Point the providers at canned data, with the throttle effectively off.

    The spacing policy is asserted separately (``test_the_rate_gate_spaces_calls``)
    so the rest of the suite does not pay a second per request.
    """
    base = config.osm_config()
    monkeypatch.setattr(osm, "osm_config", lambda: {**base, "min_interval_seconds": 0.0})
    osm.clear_cache()
    yield
    osm.clear_cache()


NOMINATIM_SEARCH = [
    {
        "place_id": 991,
        "lat": "52.7100",
        "lon": "5.7410",
        "display_name": "Emmeloord, Noordoostpolder, Flevoland, Netherlands",
        "category": "place",
        "type": "town",
        "importance": 0.61,
        "boundingbox": ["52.68", "52.74", "5.70", "5.79"],
        "address": {"town": "Emmeloord", "state": "Flevoland", "country": "Netherlands"},
        "osm_type": "node",
        "osm_id": 4242,
    },
    {
        "place_id": 992,
        "lat": "52.6250",
        "lon": "5.6550",
        "display_name": "Bant, Noordoostpolder, Flevoland, Netherlands",
        "category": "place",
        "type": "hamlet",
        "importance": 0.32,
        "boundingbox": ["52.60", "52.65", "5.63", "5.68"],
        "address": {"hamlet": "Bant"},
    },
]

NOMINATIM_REVERSE = {
    "place_id": 5001,
    "lat": "52.62500",
    "lon": "5.65500",
    "display_name": "Bant 12, 8315 Bant, Netherlands",
    "category": "place",
    "type": "hamlet",
    "boundingbox": ["52.60", "52.65", "5.63", "5.68"],
    "address": {"house_number": "12", "hamlet": "Bant", "postcode": "8315", "country": "Netherlands"},
}

OVERPASS_ELEMENTS: Dict[str, Any] = {
    "elements": [
        {
            "type": "way",
            "id": 100,
            "geometry": [{"lat": 52.624, "lon": 5.654}, {"lat": 52.626, "lon": 5.657}],
            "tags": {"highway": "track", "surface": "gravel", "note": "not forwarded"},
        },
        {
            "type": "way",
            "id": 101,
            "geometry": [
                {"lat": 52.62, "lon": 5.65},
                {"lat": 52.62, "lon": 5.66},
                {"lat": 52.63, "lon": 5.66},
                {"lat": 52.62, "lon": 5.65},
            ],
            "tags": {"landuse": "farmland", "crop": "wheat"},
        },
        {
            "type": "way",
            "id": 102,
            "geometry": [{"lat": 52.621, "lon": 5.651}, {"lat": 52.622, "lon": 5.652}],
            "tags": {"waterway": "ditch"},
        },
        {"type": "node", "id": 103, "lat": 52.623, "lon": 5.653, "tags": {"natural": "water", "name": "Farm pond"}},
        {"type": "relation", "id": 104, "tags": {"landuse": "farmland"}},
        {"type": "way", "id": 105, "geometry": [], "tags": {"highway": "path"}},
        {"type": "node", "id": 106, "lat": 52.623, "lon": 5.653, "tags": {}},
    ]
}


def fake_json(monkeypatch, *, search=None, reverse=None, overpass=None) -> List[Tuple[str, Dict[str, Any]]]:
    """Replace the HTTP seam; returns the list of calls made."""
    calls: List[Tuple[str, Dict[str, Any]]] = []

    def _fetch(url: str, params: Dict[str, Any], *, provider: str, cfg: Dict[str, Any]) -> Any:
        calls.append((url, dict(params)))
        if url.endswith("/search"):
            return NOMINATIM_SEARCH if search is None else search
        if url.endswith("/reverse"):
            return NOMINATIM_REVERSE if reverse is None else reverse
        raise AssertionError(f"unexpected provider URL {url}")

    class _Response:
        def __init__(self, payload: Any) -> None:
            self._payload = payload

        def read(self) -> bytes:
            import json

            return json.dumps(self._payload).encode()

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    if overpass is not None:
        monkeypatch.setattr(
            osm.urllib.request,
            "urlopen",
            lambda request, timeout=None: _Response(overpass),
        )
    monkeypatch.setattr(osm, "_fetch_json", _fetch)
    return calls


# --------------------------------------------------------------------------- #
# catalogue
# --------------------------------------------------------------------------- #
def test_the_basemap_catalogue_is_complete_and_attributed():
    basemaps = osm.basemaps()
    keys = [entry["key"] for entry in basemaps]
    assert keys == ["osm", "osm_hot", "osm_topo"]
    for entry in basemaps:
        assert entry["url"].startswith("https://"), f"{entry['key']} loads over TLS"
        assert "{z}/{x}/{y}" in entry["url"], f"{entry['key']} is an XYZ template"
        # Each style adds its own required credit (HOT, OpenTopoMap) on top of
        # the OSM attribution, so the base credit must be present, not alone.
        assert entry["attribution"].startswith(ATTRIBUTION)
        assert entry["licence"].startswith("ODbL")
        assert entry["max_zoom"] >= 16
    assert osm.tile_hosts() == sorted({entry["tile_host"] for entry in basemaps})
    assert "tile.openstreetmap.org" in osm.tile_hosts()


def test_the_csp_allowlist_follows_the_basemap_catalogue():
    """A tile host added to the catalogue must not be missing from the policy."""
    from security import SECURITY_HEADERS

    img_src = next(
        directive for directive in SECURITY_HEADERS["Content-Security-Policy"].split("; ") if directive.startswith("img-src")
    )
    for host in osm.tile_hosts():
        assert f"https://{host}" in img_src, f"{host} is allowed by img-src"
    connect_src = next(
        directive
        for directive in SECURITY_HEADERS["Content-Security-Policy"].split("; ")
        if directive.startswith("connect-src")
    )
    assert connect_src.strip() == "connect-src 'self'", "OSM is proxied; the browser gains no third-party origin"


def test_status_publishes_providers_policy_and_limits():
    status = osm.status()
    assert status["enabled"] is True
    names = [provider["name"] for provider in status["providers"]]
    assert names == ["Nominatim", "Overpass API", "OSM raster tiles"]
    assert "1 request per second" in status["providers"][0]["policy"]
    assert "radius-capped" in status["providers"][1]["policy"]
    assert "tile servers" in status["providers"][2]["policy"]
    assert status["limits"]["max_radius_m"] > 0
    assert status["limits"]["requests_per_second"] <= 1.0, "the published rate never exceeds the policy"
    assert set(status["default_kinds"]) <= set(osm.FEATURE_KINDS)
    assert "ODbL" in status["note"] and "server-side" in status["note"]


# --------------------------------------------------------------------------- #
# validation happens before the network
# --------------------------------------------------------------------------- #
def test_bad_input_is_rejected_without_calling_the_provider(fast_osm, monkeypatch):
    calls = fake_json(monkeypatch)
    for query in ("", "ab", "x" * 201, "line\u0000break"):
        with pytest.raises(osm.OSMError):
            osm.search_places(query)
    assert calls == [], "no upstream call is spent on invalid input"

    for lat, lon in ((91, 0), (-91, 0), (0, 181), (0, -181), ("north", 5), (None, None)):
        with pytest.raises(osm.OSMError):
            osm.reverse_geocode(lat, lon)
    assert calls == []

    with pytest.raises(osm.OSMError) as error:
        osm.features_near(52.6, 5.6, kinds=["roads", "dinosaurs"])
    assert "dinosaurs" in str(error.value)
    assert calls == []


def test_providers_can_be_switched_off_and_say_so(monkeypatch):
    base = config.osm_config()
    monkeypatch.setattr(osm, "osm_config", lambda: {**base, "enabled": False})
    for call in (
        lambda: osm.search_places("Emmeloord"),
        lambda: osm.reverse_geocode(52.6, 5.6),
        lambda: osm.features_near(52.6, 5.6),
    ):
        with pytest.raises(osm.OSMDisabled) as error:
            call()
        assert error.value.status_code == 503
        assert "disabled" in str(error.value)


def test_an_unreachable_provider_is_reported_not_guessed(fast_osm, monkeypatch):
    """The socket fails, not the seam - the error translation is what is tested."""
    import urllib.error

    def _boom(*_, **__):
        raise urllib.error.URLError("nodename nor servname provided")

    monkeypatch.setattr(osm.urllib.request, "urlopen", _boom)
    with pytest.raises(osm.OSMUnavailable) as error:
        osm.search_places("Emmeloord")
    message = str(error.value)
    assert error.value.status_code == 503
    assert "Nominatim" in message and "unreachable" in message

    status = osm.status()
    assert status["reachable"] is False
    assert "Nominatim" in (status["last_error"] or "")


# --------------------------------------------------------------------------- #
# search
# --------------------------------------------------------------------------- #
def test_search_normalises_places_and_reports_provenance(fast_osm, monkeypatch):
    calls = fake_json(monkeypatch)
    result = osm.search_places("  Emmeloord   Flevoland ", limit=5, country_codes="NL")
    assert len(calls) == 1
    url, params = calls[0]
    assert url.endswith("/search")
    assert params["q"] == "Emmeloord Flevoland", "whitespace is collapsed before the query is sent"
    assert params["limit"] == 5 and params["format"] == "jsonv2" and params["countrycodes"] == "nl"

    assert result["count"] == 2
    first = result["results"][0]
    assert first["name"] == "Emmeloord"
    assert first["lat"] == pytest.approx(52.71) and first["lon"] == pytest.approx(5.741)
    assert first["type"] == "town" and first["category"] == "place"
    assert first["bounds"] == [5.70, 52.68, 5.79, 52.74], "boundingbox is reordered to west,south,east,north"
    assert first["address"]["country"] == "Netherlands"
    assert result["attribution"] == ATTRIBUTION and result["licence"] == "ODbL 1.0"
    assert result["cached"] is False


def test_repeat_lookups_are_served_from_cache(fast_osm, monkeypatch):
    calls = fake_json(monkeypatch)
    osm.search_places("Emmeloord")
    again = osm.search_places("Emmeloord")
    assert len(calls) == 1, "the second identical lookup costs the public API nothing"
    assert again["cached"] is True


def test_reverse_geocoding_names_the_place(fast_osm, monkeypatch):
    calls = fake_json(monkeypatch)
    result = osm.reverse_geocode(52.625, 5.655)
    assert len(calls) == 1
    assert calls[0][1]["lat"] == pytest.approx(52.625, abs=1e-6)
    assert result["place"]["display_name"].startswith("Bant")
    assert result["place"]["address"]["postcode"] == "8315"
    assert result["zoom"] == 18 and result["cached"] is False


def test_reverse_geocoding_handles_unmapped_ground(fast_osm, monkeypatch):
    """A coordinate OSM has no feature for is valid, not an error."""
    fake_json(monkeypatch, reverse={"error": "Unable to geocode"})
    result = osm.reverse_geocode(52.625, 5.655)
    assert result["place"] is None
    assert "still valid" in result["note"]
    assert "Unable to geocode" in result["note"]


def test_the_rate_gate_spaces_calls(monkeypatch):
    """The Nominatim policy is 1 request/second - the gate must actually wait."""
    base = config.osm_config()
    monkeypatch.setattr(osm, "osm_config", lambda: {**base, "min_interval_seconds": 0.25})
    osm.clear_cache()
    started = time.monotonic()
    for _ in range(3):
        osm._throttle(0.25)
    elapsed = time.monotonic() - started
    assert elapsed >= 0.45, f"three gated calls take at least two intervals (took {elapsed:.3f}s)"


# --------------------------------------------------------------------------- #
# map features
# --------------------------------------------------------------------------- #
def test_features_build_a_geojson_collection_with_counts(fast_osm, monkeypatch):
    fake_json(monkeypatch, overpass=OVERPASS_ELEMENTS)
    result = osm.features_near(52.625, 5.655, radius_m=800)
    assert result["radius_m"] == 800 and result["radius_clamped"] is False
    assert result["counts"]["roads"] == 1
    assert result["counts"]["waterways"] == 1
    assert result["counts"]["water"] == 1
    assert result["counts"]["landuse"] == 1
    # The relation, the geometry-less way and the untagged node cannot be drawn.
    assert result["skipped"] == 3
    assert result["feature_count"] == 4
    assert result["truncated"] is False

    collection = result["geojson"]
    assert collection["type"] == "FeatureCollection"
    kinds = {feature["properties"]["kind"] for feature in collection["features"]}
    assert kinds == {"roads", "waterways", "water", "landuse"}
    road = next(f for f in collection["features"] if f["properties"]["kind"] == "roads")
    assert road["geometry"]["type"] == "LineString"
    assert road["properties"]["tags"] == {"highway": "track", "surface": "gravel"}
    assert road["properties"]["osm_id"] == "way/100"
    farmland = next(f for f in collection["features"] if f["properties"]["kind"] == "landuse")
    assert farmland["geometry"]["type"] == "Polygon", "a closed way is an area"
    pond = next(f for f in collection["features"] if f["properties"]["kind"] == "water")
    assert pond["geometry"]["type"] == "Point" and pond["properties"]["label"] == "Farm pond"
    assert result["attribution"] == ATTRIBUTION


def test_the_overpass_query_covers_the_requested_classes_and_is_bounded(fast_osm, monkeypatch):
    captured: Dict[str, str] = {}

    class _Response:
        def read(self) -> bytes:
            return b'{"elements": []}'

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def _urlopen(request, timeout=None):
        captured["query"] = __import__("urllib.parse", fromlist=["parse"]).parse_qs(request.data.decode())["data"][0]
        return _Response()

    monkeypatch.setattr(osm, "_fetch_json", lambda *_, **__: NOMINATIM_SEARCH)
    monkeypatch.setattr(osm.urllib.request, "urlopen", _urlopen)
    osm.features_near(52.625, 5.655, radius_m=100_000, kinds=["barriers"], limit=7)

    query = captured["query"]
    assert query.startswith("[out:json][timeout:")
    assert 'way["barrier"="hedge"](around:5000,52.625000,5.655000);' in query, "the radius is capped at the configured ceiling"
    assert 'way["barrier"="fence"]' in query
    assert query.rstrip().endswith("out geom 7;")


def test_a_clamped_radius_is_disclosed(fast_osm, monkeypatch):
    fake_json(monkeypatch, overpass={"elements": []})
    result = osm.features_near(52.625, 5.655, radius_m=250_000)
    assert result["radius_m"] == config.osm_config()["max_radius_m"]
    assert result["radius_clamped"] is True
    assert f"within {result['radius_m']:g} m" in result["note"]


def test_truncation_is_reported_rather_than_hidden(fast_osm, monkeypatch):
    elements = [
        {"type": "node", "id": index, "lat": 52.62 + index / 100_000, "lon": 5.65, "tags": {"highway": "track"}}
        for index in range(6)
    ]
    fake_json(monkeypatch, overpass={"elements": elements})
    result = osm.features_near(52.625, 5.655, kinds=["roads"], limit=4)
    assert result["feature_count"] == 4
    assert result["truncated"] is True


def test_an_upstream_overpass_error_is_not_a_silent_empty_map(fast_osm, monkeypatch):
    import urllib.error

    def _boom(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, 429, "Too Many Requests", {}, None)

    attempts = []
    monkeypatch.setattr(osm.urllib.request, "urlopen", lambda request, timeout=None: attempts.append(1) or _boom(request))
    monkeypatch.setattr(osm, "_RETRY_DELAY_SECONDS", 0.0)
    with pytest.raises(osm.OSMUpstreamError) as error:
        osm.features_near(52.625, 5.655)
    assert error.value.status_code == 429
    assert "narrow the request" in str(error.value)
    assert len(attempts) == 1, "a 429 is the provider saying slow down - it is never retried"


def test_a_transient_gateway_error_is_retried_once(fast_osm, monkeypatch):
    """The public Overpass instance 504s under load; one spaced retry fixes it."""
    import urllib.error

    calls = {"n": 0}

    class _Response:
        def read(self) -> bytes:
            return b'{"elements": [{"type": "node", "id": 1, "lat": 52.6, "lon": 5.6, "tags": {"highway": "track"}}]}'

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def _flaky(request, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.HTTPError(request.full_url, 504, "Gateway Timeout", {}, None)
        return _Response()

    monkeypatch.setattr(osm.urllib.request, "urlopen", _flaky)
    monkeypatch.setattr(osm, "_RETRY_DELAY_SECONDS", 0.0)
    result = osm.features_near(52.625, 5.655, kinds=["roads"])
    assert calls["n"] == 2, "a 504 is retried exactly once"
    assert result["feature_count"] == 1


def test_a_persistent_transient_error_still_fails_honestly(fast_osm, monkeypatch):
    import urllib.error

    attempts = []

    def _always_504(request, timeout=None):
        attempts.append(1)
        raise urllib.error.HTTPError(request.full_url, 503, "Service Unavailable", {}, None)

    monkeypatch.setattr(osm.urllib.request, "urlopen", _always_504)
    monkeypatch.setattr(osm, "_RETRY_DELAY_SECONDS", 0.0)
    with pytest.raises(osm.OSMUpstreamError):
        osm.features_near(52.625, 5.655)
    assert len(attempts) == 2, "one retry, then the failure is reported rather than hidden"


# --------------------------------------------------------------------------- #
# field geometry from a picked point
# --------------------------------------------------------------------------- #
def test_a_picked_point_becomes_an_accurate_square_field():
    drawn = geospatial.polygon_around_point(52.625, 5.6550, 1000.0)
    from shapely.geometry import shape

    polygon = shape(drawn["geometry"])
    area_ha = geodesic_area_ha(polygon)
    assert area_ha == pytest.approx(100.0, rel=0.01), f"1 km square is 100 ha (got {area_ha:.3f})"
    min_lon, min_lat, max_lon, max_lat = polygon.bounds
    assert min_lat < 52.625 < max_lat and min_lon < 5.655 < max_lon, "the point is the centre"
    # A degree box would be ~1 km tall but only ~700 m wide at this latitude.
    assert (max_lon - min_lon) > (max_lat - min_lat) * 1.5


def test_a_circular_boundary_is_an_approximation_that_says_so():
    drawn = geospatial.polygon_around_point(52.625, 5.655, 500.0, kind="circle")
    ring = drawn["geometry"]["coordinates"][0]
    assert len(ring) == 49, "a 48-gon plus the closing vertex"
    assert ring[0] == ring[-1]
    assert drawn["shape"] == "circle"


def test_a_field_boundary_near_a_pole_or_of_zero_size_is_refused():
    import data as data_module

    with pytest.raises(data_module.AOIError):
        geospatial.polygon_around_point(89.9, 5.0, 500.0)
    with pytest.raises(data_module.AOIError):
        geospatial.polygon_around_point(52.6, 5.6, 0.0)
    with pytest.raises(data_module.AOIError):
        geospatial.polygon_around_point(200.0, 5.6, 500.0)


def geodesic_area_ha(polygon) -> float:
    """Area in hectares of a WGS84 polygon, measured with the platform's own maths."""
    import geopandas as gpd

    import data as data_module

    frame = gpd.GeoDataFrame({"name": ["picked"]}, geometry=[polygon], crs="EPSG:4326")
    return float(data_module.geometry_area_hectares(frame).sum())


# --------------------------------------------------------------------------- #
# API surface
# --------------------------------------------------------------------------- #
def test_the_geo_endpoints_expose_the_providers(client):
    status = client.get("/api/geo/status")
    assert status.status_code == 200
    body = status.json()
    assert [provider["name"] for provider in body["providers"]] == ["Nominatim", "Overpass API", "OSM raster tiles"]
    assert [entry["key"] for entry in body["basemaps"]] == ["osm", "osm_hot", "osm_topo"]

    index = client.get("/").json()
    for path in ("/api/geo/status", "/api/geo/search", "/api/geo/reverse", "/api/geo/features", "/api/geo/aoi-from-point"):
        assert path in index["endpoints"], f"{path} is discoverable"


def test_search_and_reverse_through_the_api(client, fast_osm, monkeypatch):
    fake_json(monkeypatch)
    found = client.get("/api/geo/search", params={"q": "Emmeloord", "limit": 3})
    assert found.status_code == 200
    assert found.json()["results"][0]["name"] == "Emmeloord"

    named = client.get("/api/geo/reverse", params={"lat": 52.625, "lon": 5.655})
    assert named.status_code == 200
    assert named.json()["place"]["address"]["hamlet"] == "Bant"

    bad = client.get("/api/geo/search", params={"q": "ab"})
    assert bad.status_code == 400
    assert bad.json()["error"] == "OSMError"


def test_an_unreachable_provider_through_the_api_is_a_503(client, fast_osm, monkeypatch):
    import urllib.error

    monkeypatch.setattr(
        osm.urllib.request,
        "urlopen",
        lambda *_, **__: (_ for _ in ()).throw(urllib.error.URLError("offline")),
    )
    response = client.get("/api/geo/search", params={"q": "Emmeloord"})
    assert response.status_code == 503
    assert response.json()["error"] == "OSMUnavailable"
    assert "unreachable" in response.json()["detail"]


def test_features_through_the_api_return_geojson(client, fast_osm, monkeypatch):
    fake_json(monkeypatch, overpass=OVERPASS_ELEMENTS)
    response = client.get("/api/geo/features", params={"lat": 52.625, "lon": 5.655, "radius_m": 700})
    assert response.status_code == 200
    body = response.json()
    assert body["geojson"]["type"] == "FeatureCollection"
    assert body["counts"]["roads"] == 1
    assert body["attribution"] == ATTRIBUTION


def test_a_picked_location_becomes_a_stored_boundary_the_analysis_can_use(client):
    """The picked point ends up as a real AOI file with a real measured area."""
    response = client.post(
        "/api/geo/aoi-from-point",
        json={
            "lat": 52.625,
            "lon": 5.655,
            "area_ha": 12.0,
            "name": "picked_test_field",
            "label": "test block",
            "place": "Bant, Flevoland",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["stored"] is True
    assert body["name"] == "picked_test_field.geojson"
    assert body["area_ha"] == pytest.approx(12.0, rel=0.02)
    assert body["requested_area_ha"] == pytest.approx(12.0, rel=0.001)
    assert body["utm_crs"] == "EPSG:32631", "the polygon is laid out in the local UTM zone"
    assert body["center"] == {"lat": 52.625, "lon": 5.655}
    assert body["place"] == "Bant, Flevoland", "the OSM place name is kept for traceability"
    assert "surveyed" in body["note"], "the shape is disclosed as regular, not surveyed"

    # It is a normal AOI now: listed, inspectable and usable by name.
    listing = client.get("/api/aoi").json()
    assert body["name"] in [entry["name"] for entry in listing["aois"]]
    detail = client.get(f"/api/aoi/{body['name']}")
    assert detail.status_code == 200
    assert detail.json()["feature_count"] == 1
    assert detail.json()["geojson"]["features"][0]["geometry"]["type"] == "Polygon"


def test_a_picked_location_outside_the_valid_range_is_refused(client):
    assert client.post("/api/geo/aoi-from-point", json={"lat": 91, "lon": 5}).status_code == 422
    assert client.post("/api/geo/aoi-from-point", json={"lat": 52.6, "lon": 5.6, "area_ha": 0}).status_code == 422
    assert client.post("/api/geo/aoi-from-point", json={"lat": 52.6, "lon": 5.6, "shape": "hexagon"}).status_code == 422
