# Vibes Lite — Delivery Roadmap

**12 checkpoints · Scratch → Demo → Production**
Drafted **3 Oct 2026** · Last updated **8 Oct 2026** · Demo freeze **8 Oct 2026** · Production target **5 Nov 2026**

| | |
|---|---|
| **Today** | **12 Oct 2026** — post-freeze capability + hardening pass |
| **Demo freeze (CP8)** | **8 Oct 2026 — TODAY** |
| **Checkpoints complete** | 6 / 12 — CP1–CP4 (browser-verified) · **CP9 + CP10 (8 Oct)** |
| **In progress** | CP5 (**overdue**) — the 18-test console suite landed 8 Oct (`node --test crop-ai/server.test.js`); Playwright smoke + the CP4 UI pins still open |
| **Delivered beyond plan** | CP11 species identification (5 Oct) · `git init` + first commit `b036487` (5 Oct) · README setup/run/deploy guide + Vercel serverless deploy (8 Oct) · **CP9 real data connectors + CP10 workflow DAG (8 Oct)** |
| **Open before the freeze** | CP5 Playwright/pins · CP6 remaining polish · CP7 hardening + rehearsal · CP8 tag · committing today's work |
| **Longest-tail risk** | Playwright smoke still missing · Docker is **not running** · today's work is **uncommitted** |

---

## Where we are

The repository actually holds **two products**:

| | `backend/` + `frontend/` | `crop-ai/` |
|---|---|---|
| Stack | Python FastAPI + React | Single-file Node (Express) + vanilla JS console |
| Size | 17 source modules (10,776 LOC) | 8,348 LOC (`server.js` 3,874 · `app.js` 2,266 · `index.html` 668 · `styles.css` 1,257, plus `pwa.js`/`sw.js`), excluding the vendored Leaflet |
| Tests | **294 passing** (re-run 13 Oct, 10 s) | **34 passing** (13 Oct, 13 s) · 15-check Vercel harness (8 Oct) |
| Maturity | Original platform, stable | The demo face — heavily extended, near-untested |
| Status | Frozen (must stay green) | Active development |

Everything below assumes `backend/` + `frontend/` stay untouched and green.

---

## Progress log — 3 to 8 Oct 2026

- **3 Oct** — Roadmap drafted. CP1–CP4 already complete and browser-verified: CP1 geo-mapped agronomy (400 WGS84-tagged tiles, 11 map layers), CP2 nine-type sensor registry grouped per site with live SSE, CP3 Sora/Inter/JetBrains Mono console with 8 tabs and SVG-only icons, CP4 six data-integrity fixes. Python suite **143 green**.
- **4 Oct** — CP5 due. The `crop-ai/` JS test suite was **not started**; Python stayed green at 143.
- **5 Oct** — CP11 **species identification delivered** (see the checkpoint below), vision model migrated `moondream` → `qwen2.5vl:3b`; manager scripts (`tools/cropai_server.py`, `tools/ollama_server.py`, `start.sh`) updated; this roadmap refreshed; **`git init` + first commit `b036487`** at 21:27 — the critical-path recoverability item, done.
- **6–7 Oct** — No repo files touched (every mtime sits on 5 Oct or 8 Oct): CP5/CP6/CP7 did not move and the schedule slipped two days.
- **8 Oct — demo freeze day (later in the day: CP9 + CP10 shipped)** —
  - **CP9 delivered** — four real datasets beyond Open-Meteo: Sentinel-2 L2A and Sentinel-1 GRD scenes (Earth Search STAC), Copernicus DEM elevation with derived slope/aspect/drainage, and a NASA POWER cross-check against Open-Meteo that excludes fill days instead of averaging them in. `/api/sources` carries product, endpoint and attribution for all five.
  - **CP10 delivered** — a 12-node workflow DAG engine with input-hash caching; three workflows (3, 5 and 11 nodes); run history persisted to `workflows.json`; `workflow-node`/`workflow-run` SSE events; proven invalidation (a phone probe reading re-ran only `irrigation`, `soil-quality`, `report` — the 8 satellite/terrain/weather nodes stayed cached).
  - **CP5 advanced** — `crop-ai/server.test.js`, 18 tests in ~1 s on the built-in runner, wired into `npm test` / `npm run test:all` (with the 143 Python tests).
  - **CP6 advanced** — both demo fields moved off open water onto Flevoland polder farmland (`52.6250, 5.6550`, DEM -4 m, real Sentinel-2 coverage).
  - **UI** — a ninth tab, **Workflows**, with working Run / Re-run forced buttons, per-node run output, a run-history table and four connector buttons (Sentinel-2, Sentinel-1, terrain, cross-check) — verified in the browser, not just by curl.
  - **README rebuilt** as the full setup/run/deploy guide: 744 → **1,084** lines — 3-part installation (incl. Ollama pull), running-everything quick start + ports table, crop-ai configuration reference, pm2/systemd/reverse-proxy/GPU-host/Docker deployment, a row-per-symptom troubleshooting table, rebuilt TOC (22 sections); 0 emoji verified.
  - **Vercel serverless compatibility**: `api/index.js` entry, `vercel.json` (catch-all rewrite + `functions.includeFiles`), `.vercelignore`, root `package.json` dependencies + `package-lock.json` (`npm install` green), `server.js` guards (no `listen()`, no background timers, cold-start seed into `/tmp/crop-ai-data`), README "Vercel (serverless)" section.
  - **`tools/vercel_harness.js`** — 15/15 checks, both in-repo and against a simulated Vercel bundle (root deps only, no `crop-ai/node_modules`).
  - **Re-verified**: pytest **143 green (11 s)**, console + mock AI up, endpoint sweep 200s, demo routes 404, README fences balanced with 25/25 TOC anchors.
- **13 Oct — real imagery: Sentinel-2 L2A ingested from the STAC catalogue (Python platform)** —
  - **The demo-only gap closed.** Until now both products could *find* real satellite scenes but neither could **analyse** one: the console searched STAC and drew thumbnails, and the Python platform only ever analysed the synthetic scene or a manual upload. `backend/satellite.py` reads the actual band files, so the headline claim (“agriculture intelligence from real satellite imagery”) now has an end-to-end path.
  - **Discovery** — `GET /api/satellite/scenes` searches the Earth Search STAC catalogue over the field's footprint, filtered by date window and cloud cover, sorted least-cloudy-first. The catalogue implements the STAC **`query`** extension, not CQL2 `filter` — a `filter` request comes back silently unfiltered, so the threshold is **also** enforced client-side and any dropped scene is disclosed.
  - **Fetch** — `POST /api/satellite/fetch` reads only the field's window of each band COG over HTTPS range requests via GDAL `/vsicurl`: 7 bands (B02/B03/B04/B08/B05/B8A/B11), ~0.5–1.3 MB and ~27 s for a 1.4 km field, instead of a 160 MB scene. Bands are warped onto one shared grid, cloud/shadow/snow are masked through the **Scene Classification Layer**, and the result is written to `data/raw` as a normal GeoTIFF that every existing analysis endpoint accepts by name.
  - **Radiometry settled empirically, not assumed.** These COGs have `BOA_ADD_OFFSET` already applied to their pixel values (`earthsearch:boa_offset_applied = true`), so the declared `offset: -0.1` must **not** be reapplied. Verified against physics rather than metadata alone: an in-window area the SCL marks 100 % water reads **0.032** red reflectance with `DN × scale` and an impossible **−0.068** with the offset re-applied; the same choice moves Flevoland cropland NDVI from a clipped **1.30** (63 % of red pixels negative) to a sensible **0.72**. The flag, the declared values and the effective values are all recorded in the tags and the payload.
  - **Guard rails, all asserted** — an asset-host allow-list for pixel reads, radius/scene/cloud/pixel-budget caps, a processing-version in the stored file name so a dataset written by an older rule can never be served as current, validation before any network call, a third-party fault as `503` naming the provider, and named errors for a field outside the scene, a fully clouded window and an unpublished scale.
  - **UI** — a new **Satellite** page: search a place (Nominatim) or click the map, pick the field centre, read real acquisitions by date/platform/tile/cloud, download one, see the reflectance read back per band, then run NDVI on it in one click. The Dashboard's empty state now leads with *Fetch real satellite imagery* instead of the sample scene.
  - **New tests** — `tests/test_satellite.py` (**41**): catalogue posture, validation-before-network, the cloud threshold holding when the catalogue ignores it, the search box containing the requested radius, the asset-host allow-list, both radiometry conventions (including the identity-scale and unpublished-scale refusals), SCL and DN=0 masking, full-mask and outside-scene errors, the pixel budget, cache-hit payload equivalence and the API surface.
  - **Live verification (13 Oct)** — real scenes over Nagele and Flevoland; the fetched Flevoland window gave NDVI **mean 0.616 / median 0.720** over **99.3 %** usable pixels with 60.5 % dense canopy and 0 % water, and the whole flow (search → download → NDVI) was driven in the browser on the Satellite page. pytest **294 green** (was 253), console suite 34/34, harness 15/15, dashboard build clean, zero console errors.

- **13 Oct — real maps: OpenStreetMap wired end to end (both products)** —
  - **Three OSM services, all server-side** — a new `backend/osm.py` wraps **Nominatim** (forward *and* reverse geocoding) and the **Overpass API** (real map features as GeoJSON), plus the OSM **tile catalogue** itself. `POST`/`GET /api/geo/*` exposes five endpoints: `/geo/status`, `/geo/search`, `/geo/reverse`, `/geo/features`, `/geo/aoi-from-point`. The console server gained the same four read routes, so **both** apps get real place search, place naming and a feature layer.
  - **Policy compliance is implemented, not claimed** — outbound calls are spaced to the Nominatim **1 request/second** limit by a reservation-based gate, every call carries an identifying `User-Agent`, replies are cached for 15 minutes, Overpass queries are radius-capped (5 km) and feature-capped (400), and a 5xx is retried **once** while a 429 is **never** retried. `/api/geo/status` publishes all of it, and both suites assert it.
  - **Proxied on purpose** — the browser keeps `connect-src 'self'`; there is no third-party origin for data to flow through, and one place enforces the quota instead of every tab. A disabled, unreachable or refusing provider returns `409`/`503` naming the reason: no coordinate, place name or feature is ever invented.
  - **OSM is the default basemap** — OSM Street (default), OSM Humanitarian and OSM Terrain, with Esri satellite and a blank canvas alongside. The catalogue is served by `/api/geo/status` and the CSP `img-src` allowlist is **derived from it**, so the two cannot drift.
  - **Pick a field on a real map** — search a place or click anywhere, read the real address back (verified live: *“1, Lange Brink, Luttelgeest, Noordoostpolder, Flevoland”*), then turn the point into a boundary. The polygon is laid out in the local UTM zone, so a 12 ha request stores **12.00 ha** (EPSG:32631), goes through the same validation as an uploaded GeoJSON, and appears in the analysis picker without a reload. The console's version geotags the focused field through its existing `POST /api/fields/:id/geotag`.
  - **Leaflet is no longer a CDN dependency** — the console now serves Leaflet from `crop-ai/public/vendor/leaflet` (BSD-2-Clause, version-pinned with its licence), the dashboard bundles the stylesheet and marker images instead of fetching them from unpkg. Console `script-src` is exactly `'self'`.
  - **New tests** — `tests/test_osm.py` (**27**) plus **7** console tests: provider posture, catalogue↔CSP equivalence, validation-before-network, the rate gate's real spacing, Overpass query construction, element→GeoJSON conversion (relations dropped rather than misread), truncation disclosure, cache behaviour, transient-retry vs 429-no-retry, UTM area accuracy (a 1 km square is 100 ha to within 1%) and the full API surface including `aoi-from-point`.
  - **Re-verified**: pytest **253 green** (was 226), console suite **34/34** (was 26), dashboard production build clean, live round-trips against the real services (search, reverse, features, boundary creation) and **zero console errors**; the two real UI bugs found on the way (`DataTable` rendering a column object as a React child, and an un-memoised `useApi` loader looping through its own loading state on the Fields page) were fixed at the cause.

- **13 Oct — weather for any date, and Windy for the map** —
  - **`backend/weather.py`** — three keyless, server-side services: the ERA5 / ERA5-Land reanalysis archive (1940 → today) as the "any date" source, the forecast endpoint for live conditions and the days ahead, and NASA POWER as an independent second opinion. Exposed as `/api/weather/catalogue|current|daily|crosscheck|for-dates`.
  - **Two provider defects found by probing, not by reading docs.** NASA POWER's `WD10M` is out of the 0–360° range across its whole record — real responses returned −5443°, −73760° and −96080° for three different places and years — so no direction is read from it: the direction is derived from the `U10M`/`V10M` components and the raw value is recorded as *rejected*. And `ALLSKY_SFC_SW_DWN` came back as its −999 fill for every day of every window tried, so radiation is reported from Open-Meteo while POWER's is reported *unavailable* rather than as zero.
  - **The archive host is genuinely unreliable, and that is handled rather than assumed away.** Four attempts to `archive-api.open-meteo.com` inside one minute gave **502, 200, 200 and a stall past 60 s**, while the forecast host of the same service answered in under a second every time. Requests are therefore retried with backoff, and a window the archive still cannot serve falls back to NASA POWER instead of failing the request.
  - **Honesty rules baked into the data.** A day is never interpolated — an unreported day stays `null` and is counted; the summary totals cover **only days that have already happened**, so a forecast day is never added to a rain total; the most recent 14 days are flagged `provisional` because a preliminary stream can be revised; and every response names its endpoint, model family, window and licence.
  - **Windy wired in as the map, never as a number.** The Geo tab now embeds Windy's own forecast map — wind, gusts, rain, temperature, humidity, cloud and pressure layers — centred on the focused field. This is the honest half of the request: Windy's API *"returns exclusively the most recent forecast values… not possible to retrieve historical forecasts with past data"*, and its free testing key *"returns randomly shuffled and slightly modified data"*, so no value in the console is ever read from it. `GET /api/sources` publishes it under `visualizations`, deliberately separate from the data sources, the CSP gained exactly one framing origin (`embed.windy.com`), and the clickable attribution its terms require is rendered as a real link.
  - **Console** — `GET /api/weather/windy`, date-addressable `GET /api/fields/{id}/weather/history`, `POST /api/fields/{id}/weather/for-dates`, and weather on each satellite acquisition date.
  - **New tests** — `tests/test_weather.py` (**53**, no network: the suite stands in for `_http_json` with a stub that reproduces the measured provider quirks) plus **5** console tests for the Windy map: the embed URL's documented parameters, an unknown layer falling back rather than silently substituting, refusal to guess a location, live-only coverage with no archive, the CSP framing allowance staying in sync, and Windy staying out of the data-source registry.
  - **Re-verified live** (13 Oct) — the endpoint answered correctly for a real field, the iframe loaded `embed.windy.com/embed2.html` as a **200 Document** inside the page, the seven layer chips switched the map (wind → rain) and the panel followed a field change, and the browser console reported **zero errors**. Two defects were found and fixed at the cause during that pass: a `sandbox` attribute carrying both `allow-scripts` and `allow-same-origin` (which the browser warns can escape its own sandbox and which was failing the frame with `ERR_FAILED`), and an out-of-range coordinate being accepted as finite. pytest **347 green**, console suite **39/39**.

- **12 Oct — capability + hardening pass (both products)** —
  - **Index engine extended 4 → 13 indices** — NDVI, NDRE, EVI, SAVI plus GNDVI, NDMI, NDWI, OSAVI, MSAVI, PSRI, CVI, RECI, GCI. SWIR split into SWIR1/SWIR2 by centre wavelength so moisture and mineral indices resolve the right band. Every registry entry now declares `normalized: true|false`, and the completeness test asserts a difference-normalised index is bounded to `[-1, 1]` while a ratio index is only bounded below — the range metadata can no longer drift silently.
  - **Agronomy engine (`backend/agronomy.py`)** — the FarmVibes-parity gap closed with seven documented models, each publishing its own confidence level: thermal time/phenology (three GDD methods with a cut-out ceiling), FAO-56 single-Kc water balance with an irrigation schedule and stress-day count, k-means++ management zones (index + weighted spatial position), proportional-deficit variable-rate prescription with clamping, practice-weighted soil-carbon screening, index-integral yield forecast, and per-pathogen disease favourability. Exposed as eight `/api/agronomy/*` endpoints.
  - **Refusal as a feature** — the yield model returns *requires_calibration* plus the recipe instead of inventing a tonnage; the carbon screen returns a range, per-practice contributions and the list of what is still missing before the figure could be verified. Engine `ValueError`s map to HTTP `400` through a context manager scoped to the engine call only, so a genuine `ValueError` deeper in the stack still surfaces as a `500`.
  - **Design system rebuilt as brutalist** — both frontends now share one INK / BONE / ACID system: zero radius, 2px structural rules, hard offset shadows, blueprint grid underlay, Space Grotesk display + Inter text + JetBrains Mono on every measured number. Motion is `transform`/`opacity` only — View Transitions route morphs, a sliding nav indicator, scroll-driven reveals, clip-path wipes, spring easing — all disabled under `prefers-reduced-motion`.
  - **Both apps install to a phone** — manifest + service worker + generated maskable icons on the console *and* the dashboard. The console worker does network-first with cache fallback (a redeployable single-file app must not serve a stale shell); the dashboard worker caches hashed `/assets/*` cache-first, navigations network-first, and never caches `/api` or `/outputs`.
  - **Security posture is now inspectable** — `GET /api/security` returns the live header list, the full CSP, the three rate-limit tiers, the route classification rules, the accepted extensions and the runtime config, and the dashboard renders it on a new Security page. FastAPI gained CSP + 10 security headers, tiered per-address rate limiting with `RateLimit-*`/`Retry-After`, and hardened CORS; the Node console gained CSP tuned to its real asset graph, timing-safe device-token comparison, per-route limits and a path-traversal fix. Both docs and the endpoint keep saying plainly that **there is still no user authentication**.
  - **New dashboard surface** — two pages added to the seven: **Agronomy** (a tabbed workspace for all seven models, including a zones → prescription chain driven entirely from a real raster) and **Security**. FastAPI `/api/health` now advertises the agronomy models alongside the indices.
  - **Re-verified after all changes**: pytest **226 green** (was 143), console suite **26/26** (was 18), dashboard production build clean, zero browser console errors on both apps, live round-trips exercised in the browser for thermal time, water balance, zones, prescription and the yield refusal path; console PWA confirmed registered + active + controlling with a populated shell cache, dashboard SW verified in a production build; the three basemap tile hosts in the CSP checked against the hosts the code actually requests.

- **8 Oct — A-to-Z QA pass (after the freeze work)** —
  - **Backend**: `tools/qa_sweep.mjs` — **73/73 checks**, 0 FAIL, across all 46 console routes (auth, error paths, contract, caching).
  - **Two real bugs found and fixed** (found only by driving the UI, not by the API tests):
    - **Sensors tab crashed** for any field without GPS — `renderSites()` called `s.gps.lat.toFixed(4)` on a `gps: {lat: null}` object, so the whole site list (and both weather/add-sensor buttons) threw `Cannot read properties of null (reading 'toFixed')`. Now guarded, with an explicit "no GPS - geotag to unlock weather & map" label. Re-verified in the browser: refresh-weather returns *Live weather refreshed - Open-Meteo*, 2 sites render, zero page errors.
    - **Species identification could never succeed from the field imagery** — every identify call sent a **50 px map tile**, so qwen2.5vl:3b answered "no species information" (or rambled past the 120 s timeout: Ollama logged one call cut off after 1,424 tokens). Identify now sends the biggest sensible view of the real image — a square region centred on the requested tile (448 px) or the whole frame for the test round-trip (512 px) — with `max_tokens` bounded so a question can't turn into an essay. **Verified live on a real 1200×900 photograph: "Rye Grass / Hordeum vulgare", 0.85 confidence, traits and ranked candidates, 99 s (test path) and 71 s (tile path), both HTTP 200 with the crop provenance recorded**.
  - **Smaller fixes**: the workflow field selector now labels each field `GPS` / `no GPS` and defaults to a georeferenced field (the four connector buttons previously failed with "Field has no GPS georeference" out of the box); `/api/train` reuses an existing model when the dataset hash is unchanged instead of stacking identical models; identification crop provenance is stored with each entry.
  - **Browser sweep tooling**: `tools/ui_sweep.sh` + `tools/ui_sweep2.sh` click through all nine tabs and every button with real input and collect page errors **in-page**; 29 screenshots + logs in `qa-evidence/`. Result: **zero page errors**, workflow Run (0 ran / 3 reused), Re-run forced (3 ran / 0 reused, 1,745 ms), device lifecycle, GeoJSON export, geotag, train, metrics, AI vision and all four connector fetches exercised from the UI.
  - **SSE verified live**: `hello`, `sensors`, `trained`, `dataset-updated`, `device-removed` and 5 `workflow-node` + 1 `workflow-run` frames captured from a forced run.
  - **Re-verified after all changes**: pytest 143 (unchanged files), console suite **18/18**, `vercel_harness.js` **15/15**, demo routes still 404, docs at 0 emoji with balanced fences.
  - **Harness limits recorded, not hidden**: `agent-browser upload` file injection fails (Chromium won't read the injected path into a multipart body - the same photo uploads fine when the `FormData` is built in-page), and headless Chromium can't be granted camera or geolocation, so only the app's denial paths are exercised there.
  - **Demo state restored** afterwards: 2 fields (both georeferenced), 4 devices across 2 sites; test uploads and test sensors removed.

- **14 Oct — the console now reports on where the device actually is** —
  - **The gap was structural, not cosmetic.** Both stored fields sat at the same hardcoded Flevoland coordinate (`52.625, 5.655`) and a field could only exist at all as an imagery upload, so the console had no way to say anything about the place the operator was standing in — the old *Use my location* button fetched a fix into browser memory, dropped a marker and lost it on reload. A location is now a first-class thing that needs no photograph.
  - **`GET|POST|DELETE /api/location`** — the device's own fix (`navigator.geolocation`), validated and persisted to `data/location.json`, so the same point serves every tab and every console on the LAN; the broadcast rides the existing SSE stream (`location-updated` / `location-cleared`) and `farmState` carries it. `GET /api/location/live` fans out to **seven** providers in parallel for that point — live Open-Meteo weather, Nominatim place name, the 7-day reanalysis window, Sentinel-2 passes (STAC), Copernicus DEM terrain, Overpass context and the NASA POWER cross-check — each part carrying its own error so one dead upstream is named instead of blanking the panel.
  - **Refusal as the contract.** With no stored fix and no coordinates, the reads answer `404 NoLocation` / `409` and no route substitutes a default or sample coordinate; **`(0, 0)` is rejected by name** (the Null Island sentinel a GPS stack returns when it has no fix at all); the numeric gate rejects `true`/arrays/objects that JS would happily coerce to `1`; a fix moves the store only past 5 m, so following a 1 Hz GPS stream cannot become a 1 Hz writer; and a fix older than 15 minutes is labelled `stale`.
  - **Four failures, four messages.** Denied permission, no GPS radio (`POSITION_UNAVAILABLE`), a timeout, and a non-secure origin each say what they are — a browser block is not dressed up as a glitch, and a LAN IP over plain http is told to serve over TLS instead of being offered a button that quietly fails. The Geo tab asks on first visit and *only* when nothing is known; `Follow` streams from `watchPosition`.
  - **A real defect the LAN test exposed**: the CSP's `upgrade-insecure-requests` was sent unconditionally, so on a plain-http LAN origin Chrome upgraded the console's **own** `app.js` and `styles.css` to https, failed them with `ERR_SSL_PROTOCOL_ERROR`, and served a blank, scriptless page — measured, not theorised (`booted:false`, `useMyLocation:undefined`, no CSS). It is now sent exactly when it protects something (TLS, or an https-terminating proxy), the same rule HSTS already used; that page now loads fully and reports the secure-context rule honestly.
  - **New tests** — **7** console tests: the validation boundaries (Null Island, poles, antimeridian, absurd accuracy, `true`/array coercion), haversine as a measurement rather than a degree diff, the store lifecycle (empty → 404, jitter keeps the place and the store, a real move re-resolves, delete is idempotent), resolver precedence (explicit point wins; a nonsense explicit point is *not* silently replaced by the stored one), refusal-before-network, and the published rate budget. Console suite **46/46** (was 39).
  - **Re-verified live in real Chrome over CDP** (14 Oct) — with the permission granted and a position set, the console asked, stored the fix and rendered a genuine readout for `30.90100, 75.85730`: **7/7 providers answered**, *“Sher Shah Suri Marg — GT Road, Ludhiana, Punjab, 141003, India”*, 24.3 °C with the Asia/Kolkata timezone, 16.3 mm rain and 20.5 mm ET₀ over the last 7 days, 5 Sentinel-2 scenes (latest 2026-10-13, 30 % cloud), 252 m elevation at 1.67 % slope, and a `divergent` NASA POWER cross-check. The denied path was then verified for real: honest message, no coordinate, no marker, and the server still `404`. Screenshot in `qa-evidence/cp11-device-location.png`; layout measured at 1440/1024/390 px with no horizontal overflow.
  - **Limitation kept in view**: one provider did fail for real during that pass (Overpass `504`) and the panel reported it as `6/7 providers answered` with the provider's own message — which is the intended behaviour, not a defect to paper over.

---

## Phase A — Demo (CP1–CP8) · must complete 8 Oct

### CP1 · Geo-mapped agronomy — **COMPLETE**
Device/geolocation mapping with every analysis layer drawn on the map.
- 400/400 tiles carry real WGS84 lat/lon; footprints, per-tile rectangles, wind polyline, device markers.
- **11 layers**: classification, vegetation vigor, canopy cover, plant health, weed pressure, soil condition, soil moisture\*, soil pH\*, soil EC\*, soil temperature\*, soil texture (`\*` = probe-only).
- Side panels: site conditions (live Open-Meteo), soil & vegetation, per-site devices.
- Per-tile popup with the full agronomy readout + source attribution.
- `GET /api/fields/:id/layers` · `GET /api/fields/:id/geojson` · `#btn-locate` nearest-site distance.

### CP2 · Sensor network grouped by site — **COMPLETE**
- Registry of **9 device types** (soil-probe, weather-station, anemometer, rain-gauge, soil-temp, ph-ec, light, camera, generic), each with its own `deviceId` + `ingestToken`.
- Site view answers *"which sensors at which site, and what are they fetching right now"*: `FETCHING <metric>`, live value, unit, status pill (`live`/`stale`/`offline`/`no-data`), 40-point sparkline, tile coords, every secondary metric.
- `POST /api/fields/:id/sensors` · `DELETE …/:deviceId` · `POST /api/fields/:id/ingest?deviceId=` (`200`/`401`/`404` all verified).
- SSE events `device-reading` / `device-added` / `device-removed`.

### CP3 · Console typography & GUI — **COMPLETE** *(9 tabs since 8 Oct · brutalist system 12 Oct)*
- Type: **Space Grotesk** (display) + **Inter** (body) + **JetBrains Mono** (data), `font-variant-numeric: tabular-nums` globally.
- **SVG icons only — zero emoji** (verified by scan).
- 9 tabs: Operations · Labeling · Model Lab · AI Model · Analysis · **Geo Map** · **Sensors** · **Workflows** (added 8 Oct) · Applications.
- Denser work-focused cards, sticky table headers, `:focus-visible` rings, 116 DOM ids all wired.
- **Brutalist redesign (12 Oct)** — INK / BONE / ACID system shared with the dashboard: zero radius, 2px structural rules, hard offset shadows, blueprint grid underlay. Motion is `transform`/`opacity` only: a rail indicator that actually moves between tabs, View Transitions for tab morphs, hash routing, scroll-driven reveals, clip-path wipes and spring easing — all gated behind `prefers-reduced-motion`. Mobile-first: 2×2 stat grid, a horizontally-scrolling status strip above the bottom nav rail with auto-centering of the active tab.
- **Installs to a phone (12 Oct)** — manifest + service worker + generated maskable icons; verified registered, active, controlling and holding a populated shell cache.

### CP4 · Data integrity & bug hardening — **COMPLETE**
Six defects found and fixed:
1. Open-Meteo returns `0` as its **model fill value** for soil moisture — now treated as `null`, so irrigation falls back to a real probe instead of raising a false *"critical: 0%"* alert.
2. `state.geoCache` was **written but never read** → every layer switch refetched every field. Now **8 fetches → 0**.
3. Reading history read the **register form's** selector instead of the visible filter → showed one site's readings under another's heading.
4. `.pp-src` uppercased **case-sensitive IDs** (`S-0d15ca` → `S-0D15CA`).
5. Reading-history caption claimed *"newest sensor"* while showing a legacy site-level stream.
6. Camera capture could emit a **0×0 frame** if clicked before video metadata loaded.

**Verified:** 14 endpoints 200 · demo routes 404 · 116 ids, no dupes · all 8 tabs · **0 console errors** · advice de-escalation confirmed live (`Irrigate now/high/440 L` → `within 24h/medium/250 L`, provenance `device:S-0d15ca`).

---

### CP5 · Automated test coverage for `crop-ai/` — **2 / 4 · was due 4 Oct**
*Landed 8 Oct: 5,763 LOC now has a real suite rather than none.*
**Status 8 Oct:** `crop-ai/server.test.js` — **18 tests, ~1 s, all green** — boots the app the way Vercel does (`VERCEL=1`, no `listen()`, state seeded into a private temp dir) and drives it over HTTP. `npm test` runs the console suite, `npm run test:all` runs it plus the 143 Python tests; `tools/vercel_harness.js` still pins the serverless entry (15 checks). Playwright and the UI-level CP4 pins are the remaining gap.
- [x] `crop-ai/server.test.js` — node test runner; covers the layers/sensors/sites routes, token auth (`401`/`404`), device lifecycle + clamping, `soilMoisturePct()` gap logic, merged-reading attribution, both AI normalizers and the workflow DAG (cycle rejection, hash caching, invalidation).
- [ ] Playwright smoke: launch, click all 9 tabs, assert **zero console errors** and non-empty key panels. *Partly closed 8 Oct: the pass is now a scripted browser sweep (`tools/ui_sweep.sh`, `tools/ui_sweep2.sh`) that clicks every tab and button with real input and asserts zero page errors via an in-page `window.onerror`/`unhandledrejection` collector — but it drives the **agent-browser** CLI, not a Playwright spec in this repo's test runner, so the box stays open.*
- [ ] Regression pins for the CP4 fixes — the server-side ones (fill-value logic, per-metric attribution) are pinned; the three UI ones (filter ↔ table agreement, ID casing, layer-switch fetch count) are not.
- [x] Wire into `start.sh` / a `npm test` gate; keep the 143 Python tests running alongside (`npm test`, `npm run test:all` — 8 Oct).

**Exit:** `npm test && pytest` both green in one command.

### CP6 · Demo content polish — due **5 Oct** · **1 / 4**
**Status 8 Oct:** coordinates fixed — both fields now sit on real farmland (below). Camera-capture re-verification, an EXIF-GPS-wired field and the device-simulation decision have no verification on record yet.
- [x] **Move both test fields onto real land coordinates** — 8 Oct: both fields re-geotagged to `52.6250, 5.6550`, Noordoostpolder farmland in Flevoland. Verified against real data: the Copernicus DEM reports -4 m (drained polder, below sea level) and Sentinel-2 imaged it 28 hours ago, so the basemap and the satellite story both work.
- [ ] Verify the camera capture path end-to-end (`captureStream` frame → geotag → ingest).
- [ ] Re-wire one real georeferenced field with EXIF GPS so the *Analysis → Geo Map → Sensors* story is contiguous.
- [ ] Decide: enable a **manual** device-simulation button for demos (never auto-run — **no synthetic data by default**, demo routes stay 404).

**Exit:** satellite basemap renders imagery; one field tells the complete story from upload to irrigation advice.

### CP7 · Demo hardening & performance — due **7 Oct** · **mostly open**
**Status 8 Oct:** what has real verification is the documentation path — README rewritten and scanned (0 emoji, balanced fences, 25/25 anchors), `bash -n start.sh` clean, manager scripts exercised (start/stop/status, console + mock AI serving, endpoint sweep green). Degraded modes, perf audit, error-state audit and the rehearsal/recording are open; a literal clean-shell `./start.sh` run has not been done.
- [ ] Degraded-mode states: weather API down, AI backend down, geolocation denied (partial — currently fails gracefully), SSE reconnect.
- [ ] Perf: layer payloads for 400-tile fields, map repaint budget, initial load waterfall.
- [ ] Error/empty states audited across all 9 tabs.
- [ ] README + `./start.sh` one-command launch verified from a clean shell.
- [ ] Capture a demo recording and write the runbook (talk-track, what to click, fallbacks).

**Exit:** rehearsed twice end-to-end with no manual fixes.

### CP8 · **DEMO VERSION FREEZE — v0.1** · **8 Oct** — MILESTONE · **DUE TODAY**
**Status 8 Oct:** not executed yet. Gate readiness: `pytest` 143 green · console suite **18/18** green (`npm test`) · Vercel harness 15/15 · real Sentinel scenes, DEM terrain, weather cross-check and workflow runs verified live over curl *and* in the browser console · Playwright smoke **missing** · runbook/recording not written · today's changes uncommitted.
- [ ] Tag the state, freeze scope, **no feature work after this date**.
- [ ] Deliverables: one-command launch (`./start.sh [--mock-ai]`), demo runbook, recording, known-issues list.
- [ ] Full gate: `pytest` (143) + `npm test` + Playwright smoke + endpoint sweep + console-error check.

**Demo scope = CP1–CP7 complete.** Everything after this is explicitly *not* in the demo.

---

## Phase B — FarmVibes parity → Production (CP9–CP12) · CP9 + CP10 delivered 8 Oct

Reference: **[microsoft/farmvibes-ai](https://github.com/microsoft/farmvibes-ai)** — multi-modal geospatial ML for agriculture. Its three pillars are *dataset preparation*, *a notebook model library*, and an *inference engine* over a configurable workflow DAG. The checkpoints below map those pillars onto this codebase.

### CP9 · Fusion-ready data connectors — **DELIVERED 8 Oct** (due 13 Oct)
FarmVibes ships downloaders for Sentinel-1/2, US Cropland Data, USGS elevation, NAIP, NOAA weather and Ambient Weather. Four real, keyless datasets now sit alongside Open-Meteo.
- [x] **Sentinel-2** optical (10/20 m) — `GET /api/fields/{id}/satellite` returns real scenes with datetime, cloud cover, platform, thumbnail and STAC item link (verified 8 Oct: scenes 28 h old at 40.3% cloud).
- [x] **Sentinel-1 SAR** — same route with `?collection=sentinel-1-grd`; cloud cover is reported as absent rather than faked as 0% (verified 8 Oct: 3 scenes in 30 days).
- [x] **Elevation / slope** — Copernicus DEM sampled at five points across the footprint → elevation, relief, slope %, slope degrees, aspect and a drainage verdict (verified 8 Oct: -4 m, flat, ponding risk).
- [x] **Second weather source for cross-validation** — NASA POWER against Open-Meteo over the days *both* report real values; NASA POWER's `-999` fill days are excluded and counted, never averaged in (verified 8 Oct: 4 shared days, ΔT -0.27 °C, agreement "close"). *NOAA NWS is US-only, so NASA POWER was chosen for global coverage; the NWS API drops into the same node for US fields.*
- [x] Keep the *no-synthetic-data* contract: only real fetched sources, each with provenance.

**Exit:** a `sources` registry where every layer value carries which dataset produced it — **met**: `/api/sources` lists all five datasets with product, endpoint and attribution, and every connector response embeds the same provenance block.

### CP10 · Workflow DAG + inference engine — due **20 Oct**
FarmVibes's core idea: workflows are a **directed acyclic graph** of download → prepare → operators, re-run automatically when upstream data changes.
### CP10 · Workflow DAG + inference engine — **DELIVERED 8 Oct** (due 20 Oct)
FarmVibes's core idea, implemented: workflows are directed acyclic graphs of fetch → prepare → infer nodes, executed in topological order, with **every node result cached under a hash of its inputs** (field fingerprint, parameters and the hashes of its dependencies).
- [x] **DAG runner in `server.js`** — 12 node types (field geometry, weather, weather cross-check, terrain, Sentinel-2, Sentinel-1, classification, irrigation, soil index, context merge, acquisition pick, report); Kahn topological sort that **rejects cycles**; three workflows of 3, 5 and 11 nodes.
- [x] **Area-of-interest + time-range as first-class inputs** — the field georeference and GeoJSON footprint are the AOI; `params.days` / `maxCloud` / `limit` are the range, and a changed window produces its own cached run.
- [x] **Re-run on upstream update** — proven live: after a soil probe reported 18.5% VWC, a re-run executed **only `irrigation`, `soil-quality` and `report`** while all eight satellite/terrain/weather nodes stayed cached; with no changes at all, zero nodes execute. `workflow-node` and `workflow-run` stream on the existing SSE bus.
- [x] **REST surface** — `POST /api/workflows/{id}/run` (`{fieldId, force, params}`), `GET /api/workflows/{id}/runs?fieldId=&limit=`, `GET /api/workflow-runs/{runId}` (full node outputs), `POST /api/workflow-runs/clear`; history persists to `crop-ai/data/workflows.json`, keeping outputs for the newest run of each workflow + field.

**Exit:** add a date range, get a versioned derived product; refresh after new imagery and only affected nodes recompute — **met** (run history in the Workflows tab shows ran/reused per node).

### CP11 · Fusion model library — due **27 Oct**
Maps FarmVibes' notebook library onto ours (their `harvest_period`, `carbon`, `deepmc`, `crop_segmentation`):
- [x] **Plant species identification** — delivered 5 Oct (re-verified 8 Oct): camera frame or geo-map tile → species, type, confidence, ranked candidates, health + traits, through a dedicated identify endpoint (`POST /api/ai/identify`, `GET /api/identify`) backed by a **local Ollama vision model** (`qwen2.5vl:3b`, migrated from `moondream`; its own endpoint block in `ai-config.json`, contract in the user turn, 120 s timeout). Results stored with time and place — 3 identifications on record (2 bumblebee, 1 *Poa pratensis*); an unconfigured, unreachable or unnameable input returns 409/502, never a guessed species.
- [ ] **NDVI time-series → emergence & harvest date detection** (FarmVibes `harvest_period`), using Sentinel-2 history across the season rather than a single image.
- [ ] **Crop segmentation / identification** — extends the existing `dataset/from-labels → train → predict` loop with multi-temporal inputs.
- [ ] **Micro-climate prediction** (FarmVibes `DeepMC`) — station + terrain fusion feeding irrigation and spraying advisories.
- [x] **Soil carbon / sustainability estimate** (FarmVibes `carbon`, COMET-Farm style) — delivered **12 Oct**: practice-weighted screening with saturation over time, per-practice contributions and an explicit *not MRV-grade* verdict plus the list of what is still missing before the figure could be verified (`POST /api/agronomy/carbon`).
- [x] **Thermal time / phenology + disease risk** — the two remaining FarmVibes-adjacent insight products landed **12 Oct** as part of the agronomy engine: GDD-driven stage tracking with days-to-next-stage, and per-pathogen temperature/wetness favourability that states it is not a diagnosis. Emergence/harvest-date detection from Sentinel-2 history (`harvest_period`) still uses the season-wide series rather than the single-image path, so that box stays open.
- [ ] **SpaceEye-style cloud-free compositing** — the practical enabler: without it, optical time-series break on cloudy days.
- [ ] Keep the **external-AI contract** intact (`/api/ai/*`, generic provider) so any of these can run locally or remotely.

**Exit:** four insight products beyond today's single-pass classification, each explainable with provenance.

### CP12 · Production hardening — due **5 Nov** — TARGET
- [x] **Repo**: `git init` + first commit `b036487` on **5 Oct** (`.gitignore` already present, `main` tracks `origin/main`); CI still open, and today's Vercel/README changes are **uncommitted**.
- [x] **Serverless deploy path (Vercel)** — landed **8 Oct**: `api/index.js` entry, catch-all rewrite, `functions.includeFiles` bundle, `.vercelignore`, cold-start seed into `/tmp`, 15-check harness, README deploy section. A real `vercel` deploy still needs an account.
- [ ] **Containerize**: Dockerfiles exist but **Docker is not running** — bring up `docker-compose.yml`, image the Node console and the Python platform together.
- [x] **Rate limits on device writes** — delivered **12 Oct** on both back ends: three tiers on the API (read/write/analysis) and per-route limits on the Node console, each enforced rather than only advertised, with a regression test proving it.
- [ ] **Auth & tenancy**: per-farm accounts, API keys scoped to sites, replacing the single shared `ingestToken` model. *(Device-token comparison is now timing-safe and the dashboard's Security page states the gap in the product rather than only in the docs — but the model itself is unchanged.)*
- [ ] **Real persistence**: move `data/*.json` to PostgreSQL (spatial: PostGIS for tile/field geometry) + object storage for imagery; migration path from current JSON.
- [ ] **API versioning** (`/api/v1`), pagination, idempotent ingest, rate limits on device writes.
- [ ] **Observability**: structured logs, metrics (ingest latency, weather-fetch failure rate, layer payload size), health/readiness probes.
- [ ] **Ops**: staging + production environments, backups, rollout/rollback, runbook.
- [x] **Attribution for basemap providers** — done 13 Oct for the OpenStreetMap stack: every map renders the visible ODbL credit with a link to the copyright page, `/api/geo/status` publishes provider, licence and policy for each service, and the Security page shows the live posture. Sentinel attribution remains on the console's `/api/sources`.
- [ ] **Compliance/quality**: data-retention policy and a model-card for each CP11 insight.

**Exit:** multi-user, containerized, backed-up, monitored — deployable by someone who did not build it.

---

## Critical path to 8 Oct

```
CP5 tests ──────── CP6 demo content ──── CP7 hardening ──── CP8 FREEZE
 Oct 3-4                Oct 5                 Oct 6-7          Oct 8
 (0 tests today)     (map looks broken     (rehearse twice)   (tag & stop)
                       until coords fixed)
```

**Three things that must happen this week, in order:**

1. **CP5** — 5,763 LOC with a thin test suite means every later fix risks silent regression.
2. **CP6 coordinate fix** — one line of data, but until it lands the map *looks* broken in front of an audience.
3. **`git init`** — currently nothing is recoverable. Do this **before** CP5 starts, not after.

**Status of the three on 8 Oct (freeze day):**

1. **CP5** — substantially closed: 18-test console suite + Vercel harness are green; Playwright and the UI-level CP4 pins remain.
2. **CP6 coordinates** — still open; both fields remain over open water (re-checked 8 Oct).
3. **`git init`** — **done 5 Oct** (`b036487`); the warning above is historical. Today's README/Vercel work is still uncommitted — commit it before tagging CP8.

---

## Legend

| Marker | Meaning |
|---|---|
| **COMPLETE** | Finished and browser-verified |
| **OPEN / overdue** | Untouched or partial, and past its due date |
| **MILESTONE** | Hard deadline |
| **TARGET** | Production target |
| **RISK** | Known risk |

*Scope rule: CP8 is a hard boundary. Anything in CP9–CP12 is post-demo and must not be pulled forward into demo week.*
