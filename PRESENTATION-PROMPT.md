# Presentation Brief — Vibes Lite / Crop AI

> **How to use this file.** Everything below is one prompt. Paste it into a
> presentation-generating model (or hand it to a designer) and it should produce
> a complete, factual 10-slide deck about this project. Sections 1–8 are the
> source material; section 9 is the slide blueprint the model must follow;
> section 10 is the fact-check list; section 11 is the delivery checklist.
> Nothing in this file is aspirational — every number was read off the running
> system or the test suite on 24 October 2026.

---

## 0. The task, stated exactly

You are a presentation designer and technical storyteller. Produce a deck of
**at most 10 slides, including the title slide and the closing slide**, that
explains **what Vibes Lite is, how it works end to end, and how the team works**.

Audience: a mixed panel — one agronomist, one judge/investor, one engineer.
They have **ten minutes**. They should leave knowing three things:

1. A drone or phone photo becomes a measured, georeferenced field report.
2. The same system ingests real weather, real satellite scenes and real device
   telemetry, and refuses to invent a number it cannot support.
3. This is a working product with tests and evidence, not a mock-up.

Tone: confident, plain, specific. No hype adjectives ("revolutionary",
"cutting-edge", "game-changing"). Every claim is a capability that exists today.

---

## 1. Hard constraints

- **Exactly 10 slides.** One idea per slide. 3–5 bullets maximum, 12 words or
  fewer each. The speaker note carries the detail, not the slide.
- **Numbers must match section 8.** Do not round 75 tests to "hundreds", do not
  call the kNN model "deep learning", do not claim drone autonomy, satellite
  constellations beyond Sentinel-1/2, or cloud infrastructure that does not exist.
- **Never claim an accuracy figure** other than what the Model Lab reports for
  the user's own labelled tiles. The current demo model is small; its
  cross-validation metrics are honest and low, and that is part of the story.
- **Name the limits.** Slide 9 exists precisely to state them. A deck that
  hides them is off-brief.
- **Screenshots beat mockups.** Use the captured evidence in `qa-evidence/`
  (section 11). Never draw a fake dashboard.
- Include one **architecture diagram** (slide 3) and one **pipeline diagram**
  (slide 4). ASCII/SVG/Mermaid is fine; boxes and arrows, not stock photos.
- 16:9. Dark-on-light or light-on-dark, but one accent colour only.

---

## 2. What the project is, in one paragraph

Vibes Lite is an open agriculture-intelligence stack in two halves that share
one idea: **a field is a grid of measured tiles, not a single guess.**

- **Vibes Lite (Python + React):** a FastAPI geospatial engine and dashboard that
  turns Sentinel-2 or drone rasters into vegetation indices, crop-health zones,
  agronomy models and reports.
- **Crop AI console (single Node process):** a field console where a drone or
  phone image is tiled, labelled in the browser, used to train a kNN classifier,
  and then painted back onto a real satellite map — with live weather, real
  Sentinel scenes, terrain, OpenStreetMap context, a workflow DAG and a
  first-class sensor registry that accepts readings from ESP32/Arduino/RPi.

It is an independent implementation inspired by the *concepts* of Microsoft
FarmVibes.AI, with no shared code and no runtime dependency on it.

---

## 3. Product A — Vibes Lite platform

### 3.1 Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11, FastAPI, Uvicorn, Pydantic |
| Geospatial | Rasterio, GeoPandas, Shapely, pyproj, Pyogrio |
| Imaging / CV | OpenCV (headless), NumPy, Pillow |
| Data & charts | Pandas, Matplotlib |
| Frontend | React 18, Vite 5, React Router, Recharts, Leaflet |
| Packaging | Docker, Docker Compose |
| Tests | pytest + httpx |

### 3.2 The processing pipeline

```
AOI + raster → clip to boundary → band stack → index (e.g. NDVI)
             → crop-health classes → weak zones / anomalies
             → maps + charts + result.json → API → dashboard
```

Design rules the code actually enforces: engines never import the API; the API
orchestrates; thresholds and limits live in `config.yaml`; raw data is
read-only; repeat analyses hit a result cache instead of reprocessing.

### 3.3 Nine dashboard pages

Dashboard · Fields · NDVI · Crop Health · Computer Vision · Time Series ·
Agronomy · Results · Security.

### 3.4 Index engine — 13 indices, one dispatch path

NDVI, NDRE, EVI, SAVI, GNDVI, NDMI, NDWI, OSAVI, MSAVI, PSRI, CVI, RECI, GCI.
Division by zero, nodata and invalid pixels are handled explicitly; band choice
is always reported; each index declares whether it is normalised to `[-1, 1]` or
an unbounded ratio, so a UI can never colour-scale a ratio index as if it were
NDVI. SWIR is split into SWIR1/SWIR2 by centre wavelength.

### 3.5 Agronomy engine — seven models, each declaring its confidence

| Model | Method | Honest confidence |
|---|---|---|
| Thermal time & phenology | GDD (average / modified / sine) | published method, indicative stage lengths |
| FAO-56 water balance & irrigation | single-Kc ETc, root-zone depletion | published method, indicative coefficients |
| Management zones | k-means++ on index + spatial position | descriptive — needs ground truth |
| Variable-rate prescription | proportional-deficit over zones | advisory |
| Soil carbon screening | practice-weighted screening | screening only, not MRV-grade |
| Yield forecast | linear index-integral regression | requires local calibration |
| Disease favourability | per-pathogen temperature/wetness rules | favourability, not diagnosis |

The engine refuses to invent: an uncalibrated yield request returns the
calibration recipe instead of a tonnage.

### 3.6 Real satellite ingestion

Copernicus Sentinel-2 L2A via the Earth Search STAC catalogue. Only the window
over the field is read from the public Cloud-Optimised GeoTIFF hosting — a
1 km field pulls a few hundred kilobytes out of a 10 980 × 10 980 px scene.
Pixels are converted to surface reflectance with the published radiometry,
cloud/shadow/snow are masked through the Scene Classification Layer, and the
window is stored with the STAC item id, acquisition time, cloud cover and
licence in its tags.

### 3.7 Security posture

CSP on every response (including errors), `nosniff`, `DENY` framing, referrer
and permissions policy, COOP/CORP. Three rate tiers (read 1200/min, write
240/min, analysis 120/min) with `RateLimit-*` headers and `Retry-After`.
Leaflet is bundled locally, so `script-src` is `'self'`. Upload allow-lists,
safe filenames, 200 MB cap, CORS restricted to configured origins.
`GET /api/security` returns the live posture and **states what is missing: no
user authentication, no multi-tenant isolation, no audit log.**

---

## 4. Product B — the Crop AI field console

### 4.1 How it runs

One Node process (`crop-ai/server.js`) serves both the JSON API and the static
console. No build step, no bundler, no framework on the client. Boot it with
`./start.sh` → `http://localhost:5177`. `--mock-ai` also starts a reference
vision model on `:5199`. Optional local species model: Ollama `qwen2.5vl:3b`
on `:11434`. Node 18+ only. 62 HTTP routes. `api/index.js` re-exports the same
server as a Vercel function, so the console deploys to a serverless host
unchanged.

### 4.2 The six-stage pipeline

1. **Ingest** — upload or camera-capture real imagery; EXIF GPS is extracted
   automatically, otherwise the field is geotagged by hand.
2. **Tile** — the image becomes a grid (default 50 px tiles).
3. **Train** — label tiles HEALTHY / STRESSED / SOIL / WEED; 13 features
   (RGB statistics, excess-green, VARI, OpenCV-wasm texture and edges) feed a
   cosine kNN with k-fold cross-validation — up to 5 folds, fewer when a class
   has very few labels; the Model Lab shows accuracy, per-class
   precision/recall/F1 and the confusion matrix.
4. **Test** — `POST /api/tile` classifies any unseen tile image.
5. **Analyze** — `POST /api/predict` classifies every tile, writes a heat
   overlay PNG and returns per-class percentages plus a recommendation.
6. **Smart farm** — real weather, device telemetry and crop condition become
   irrigation advice and alerts, streamed live over SSE.

### 4.3 The nine console tabs

| Tab | What it does |
|---|---|
| **Operations** | Ingest imagery, live pipeline state, field registry, KPI count-ups |
| **Labeling** | Tile-by-tile ground truth, dataset build from labels |
| **Model Lab** | Every trained model on disk, cross-validation metrics, confusion matrix, quick-classify an unseen tile |
| **AI Model** | Point at any HTTP vision model (Generic JSON or OpenAI-compatible), test it, save it; separate species-identification endpoint |
| **Analysis** | Georeference the field, source image vs classification overlay, composition + advisory |
| **Geo Map** | 11 drawable agronomy layers on real basemaps, OSM search and features, wind rose, sensor markers, Windy forecast embed |
| **Sensors** | Sites → deployed sensors → live values, register a probe, ingest endpoint, reading history, SSE activity feed |
| **Workflows** | Three workflow DAGs with per-node cache, fusion-source buttons, run history |
| **Applications** | Field missions (health, growth, scouting, weeds, soil, ripeness, custom classes) mapped to what the 4-class model actually supports |

### 4.4 Sensors — the part that changed this week

- **Registry, not a table.** `POST /api/fields/{id}/sensors` installs a probe
  and returns a `deviceId` (`S-xxxxxx`) plus its **own ingest token**. Site-wide
  token still works; per-device token is the finer grant.
- **Nine device types:** soil probe, weather station, anemometer, rain gauge,
  soil temperature, pH/EC probe, light sensor, field camera, generic. Each
  declares the metrics it is expected to report.
- **Real ingest:** `POST /api/fields/{id}/ingest?deviceId=S-xxxxxx` with header
  `X-Sensor-Token`. Accepted keys: `soilMoisture`, `temperatureC`,
  `humidityPct`, `ph`, `ec`, `rainMm`, `soilTempC`, `windKmh`, `lightLux`,
  `battery`. Every value is clamped to its physical range. A wrong token is a
  401, an unregistered device is a 404 — never a silently accepted reading.
- **Liveness, computed not stored:** `live` under 15 minutes, `stale` under 24
  hours, `offline` after that, `no-data` if the probe never reported. A trend
  sparkline is drawn from the last 40 readings of that device's primary metric.
- **Per-metric merge.** Readings are merged per metric by newest timestamp, so a
  wind-only anemometer that reports later can never shadow the soil probe's
  moisture. The merge remembers which device produced each value and the UI
  names it: `moisture 26.4% (S-0d15ca)`.
- **Crop and soil context, live on the Sensors tab.** Each site block now shows
  a crop strip — canopy cover, health score and grade, healthy/stressed hectares,
  NDVI — and a soil strip — quality score and grade, moisture with its source,
  pH, EC, soil temperature. Both are recomputed on every read, so a fresh probe
  packet immediately changes the soil verdict above the cards.
- **Connectivity demo, end to end.** Each sensor card has a **Test packet**
  button. It fetches the site token, then POSTs one reading to the real ingest
  endpoint from the browser — the exact path an ESP32 takes. On success the card
  flips to `live`, the sparkline grows, the SSE activity feed logs
  `S-xxxxxx ingested · n values`, the reading history rebuilds and the crop/soil
  strip recalculates. Nothing is simulated in the store; a real HTTP request
  with a real token has to succeed.
- **Soil quality index** is deterministic and inspectable: moisture is scored
  against a 25–45 % VWC comfort band, pH against 6.0–7.5, EC against ≤ 1.2,
  plus a water balance (ET₀ vs rain) and bare-soil exposure; the final score is
  75 % measured inputs + 25 % exposure, graded Good ≥ 85, Fair ≥ 70, Poor ≥ 50,
  Critical below. With no probe and no georeference it returns
  **"Insufficient data"** rather than a number.

### 4.5 AI, on your terms

- **Any HTTP vision model.** Generic JSON or OpenAI-compatible. The console
  sends `{model, task, classes, image, grid, context}` and reads plant health,
  weed area and soil quality out of the reply. `--mock-ai` runs the bundled
  reference model so the chain can be seen working before a real GPU is wired in.
- **Species identification is a second endpoint**, because naming a species is a
  different problem from four-state ground cover. Default: local Ollama
  `qwen2.5vl:3b`, fully offline. An unreachable model returns 409/502 — never a
  guessed species. Every identification is stored with time, GPS/tile and
  confidence.
- **Graceful fallback, stated aloud.** If no external model is configured, the
  local kNN answers and the report says `source: local-model`.

### 4.6 Fusion sources and the workflow DAG

Six real datasets, each with endpoint, product, attribution and fetch time:

1. Sentinel-2 L2A optical scenes (Earth Search STAC)
2. Sentinel-1 GRD SAR scenes
3. Open-Meteo forecast (weather, wind, ET₀, satellite soil moisture)
4. Open-Meteo archive / ERA5 — **any date back to 1940**
5. Open-Meteo elevation (Copernicus DEM)
6. NASA POWER daily agrometeorology (cross-check against Open-Meteo)

Plus **Windy**, deliberately filed under `visualizations`, never under sources:
its interactive wind/rain/temperature map is embedded with the attribution its
terms require, but it publishes forecasts only and no value in the console is
read from it. A test asserts that split so a later edit cannot quietly promote a
map into a measurement.

Three workflows, each a DAG of `fetch → prepare → infer` nodes, each node
cached by an input hash:

| Workflow | Nodes | What it proves |
|---|---|---|
| `local-agronomy` | 5 (field-geo, classify, irrigation, soil-quality, report) | Works offline, no network at all |
| `field-refresh` | 13 (Sentinel-2 + Sentinel-1 scenes, live weather, NASA cross-check, 90-day ERA5, DEM terrain, scene-day weather, context merge, then the four agronomy nodes) | Full field context in one press |
| `imagery-window` | 3 (field-geo, satellite-optical, acquisition-window) | Picks the least-cloudy acquisition — the input cloud-free compositing needs |

The caching rule is the interesting part: a **new sensor reading invalidates only
the agronomy nodes** (`irrigation`, `soil-quality`, `report`); the expensive
satellite, terrain and weather fetches stay cached. The test suite asserts
exactly that set, so a refactor cannot make a probe packet re-download a scene.

### 4.7 How the console stays honest

- **No synthetic data.** No fake-field generator, no simulated sensor stream, no
  demo endpoint. A boot sanitizer strips any legacy synthetic artefact.
- **Every number is traceable** to an EXIF header, Open-Meteo, a device reading
  or a labelled tile — and the UI names which.
- **Missing data is louder than fake data.** No GPS → the map says geotag
  first and returns 409, it does not default to `(0, 0)` (Null Island is
  explicitly rejected). No soil input → "Insufficient data". Model down → 502
  with the provider named.
- **Constant-time token comparison** on ingest, per-route rate budgets and a
  global 600 requests/minute limit, CSP matched to the actual asset graph.
- **Single source of truth for sensor state**: `data/sensors.json`, persisted on
  every accepted packet, broadcast on SSE.

---

## 5. Architecture at a glance (for slide 3)

```
                    ┌─────────────────────────────────────────────┐
   drone / phone ──▶│  Crop AI console  (Node, one process :5177) │◀── ESP32 / RPi
      image         │  static UI · 62 JSON routes · SSE hub       │    X-Sensor-Token
                    └───────┬───────────────┬─────────────┬───────┘
                            │               │             │
                    ┌───────▼──────┐ ┌──────▼──────┐ ┌────▼─────────────┐
                    │ kNN tile     │ │ workflow    │ │ sensor registry  │
                    │ classifier   │ │ DAG + cache │ │ + soil index     │
                    │ (13 feats)   │ │ (3 graphs)  │ │ (per-metric merge)│
                    └──────────────┘ └──────┬──────┘ └──────────────────┘
                                            │
        ┌───────────────────────────────────┼───────────────────────────────┐
        ▼               ▼               ▼   ▼            ▼                  ▼
   Sentinel-2      Sentinel-1     Copernicus DEM   Open-Meteo        NASA POWER
   (STAC + COG)    (STAC)         (elevation)      forecast+ERA5     (cross-check)
                                                   1940 → today
```

The Python platform sits beside it for raster-scale work: FastAPI + Rasterio +
13 indices + 7 agronomy models + React dashboard, deployed with Docker Compose.

---

## 6. The demo script that works today (verified 24 Oct 2026)

Two fields are registered (`upload-test`, `real-drone-test`), both analysed and
georeferenced; four sensors are deployed across the two sites; three models are
on disk. Total run: about 90 seconds.

1. **Operations** — 2 fields, 2 analysed, 2 georeferenced, 3 models; the field
   registry lists both with their image, grid and status.
2. **Analysis** — pick `upload-test`: 20 × 20 grid over 3.24 ha, the classified
   overlay beside the source image, composition and advisory on the right.
3. **Geo Map** — the field drawn at 52.6250, 5.6550 with real OSM basemap, the
   layer switcher (plant health, soil condition, probe-measured moisture/pH/EC),
   wind rose and the Windy embed.
4. **Sensors — the connectivity demo.** Point at a card, press **Test packet**.
   In one second: the liveness pill goes `offline → LIVE`, the sparkline gains a
   point, the activity feed logs `S-0d15ca ingested · 4 values`, and the soil
   strip above updates its moisture, pH, EC and soil temperature from the packet
   just received. This is a real POST to `/api/fields/{id}/ingest?deviceId=…`
   with the site's token — the ESP32 path, exercised from the browser.
5. **Sensors — crop and soil at a glance.** Each site block reads
   `CROP canopy 100% · health 63.4/100 Fair · 3.24 ha healthy · NDVI 0.917` and
   `SOIL 99.9/100 Good · moisture 26.4% (S-0d15ca) · pH 6.38 · EC 1.11 · soil
   temp 13.2°`. The device id next to the moisture value is the provenance.
6. **Workflows** — run `field-refresh`: 13 nodes, live Sentinel/weather/DEM
   fetch on the first run, then re-run and watch every node report `cached`.
   Post one sensor packet, run again: only `irrigation`, `soil-quality` and
   `report` re-execute.
7. **AI Model** — status chip, a live test round-trip, the species endpoint
   configured for local Ollama.

If asked "is that data real?": every pixel has a source, and the console prints
that source next to the number. That is the demo.

---

## 7. How the team works (slide 9 material)

- **Build the smallest honest thing, then prove it.** Every feature ships with a
  test or a captured screenshot; the repository carries 36 QA screenshots and a
  written QA report.
- **Verification is part of the feature.** The Node suite has **75 tests across
  three files** — server routes, library math, and the area-analysis routes — and
  it is green (`75 pass / 0 fail`) after the sensor work in this brief. The
  Python side has a pytest suite for indices, satellite reads and the agronomy
  API.
- **Tests assert the rules, not just the happy path:** a wrong sensor token is
  401, an unregistered device is 404, a sensor reading invalidates exactly three
  workflow nodes, Windy is never listed as a data source, the CSP allow-list
  matches the basemap catalogue in both directions.
- **Non-negotiable honesty layer.** Where a model cannot know something, the
  product says so in the UI and in the API response. That rule is what makes the
  agronomy output usable by an actual advisor.
- **Small surface, no build step.** The console is plain ES modules and CSS
  variables: 5,007 lines of server, 2,816 of client, 1,341 of CSS, 728 of HTML.
  It runs on a field laptop with no internet except the map tiles.

---

## 8. Numbers you may quote (verified)

| Fact | Value |
|---|---|
| Console HTTP routes | 62 |
| Node test suite | 75 tests, 75 pass, 0 fail |
| Console source | server.js 5,007 lines · app.js 2,816 · styles.css 1,341 · index.html 728 |
| Tabs | 9 |
| Sensor device types | 9; 10 accepted ingest metrics |
| Workflows | 3 (5, 13 and 3 nodes) |
| Fusion data sources | 6 + Windy as a visualisation only |
| Vegetation indices (Python) | 13 |
| Agronomy models (Python) | 7 |
| Dashboard pages (Python) | 9 |
| Weather history | 1940 → today (ERA5 / ERA5-Land) |
| Default tile grid | 50 px tiles; demo fields 20×20 and 4×4 |
| Liveness windows | live < 15 min · stale < 24 h · offline ≥ 24 h |
| Soil grade bands | Good ≥ 85 · Fair ≥ 70 · Poor ≥ 50 · Critical < 50 |
| Runtime | Node 18+, one process, no build step, no database |
| Persistence | JSON files under `crop-ai/data/` (`fields`, `sensors`, `models`, `workflows`, `identifications`, `location`) |

---

## 9. Slide blueprint — follow this exactly

Ten slides, ten minutes. Roughly one minute per slide, and slide 8 (sensors)
gets ninety seconds.

**Slide 1 — Title.**
*Vibes Lite: from a photo of a field to a measured decision.*
Subtitle: drone + satellite + probe, one console. Presenter names and date.
Visual: the console's Operations screen (`qa-evidence/tab-ops.png`), dimmed
behind the title.

**Slide 2 — The problem.**
*Farm decisions are made on averages, weeks late.*
Bullets: a field is not uniform; imagery arrives as whole scenes, not answers;
soil probes and weather live in different silos; advice without provenance is
unusable. One line: "we join the four sources, per tile, and show the source."
Visual: single photo split into four colour-coded treatments.

**Slide 3 — The system.**
*One stack: raster platform + field console.*
The architecture diagram from section 5. Two labels only: "Python: raster-scale
geospatial" and "Node: field-scale, real-time". Say aloud: single machine, no
cloud required, 62 routes.

**Slide 4 — How an image becomes an answer.**
*Six stages: ingest → tile → label → train → classify → act.*
The pipeline from section 4.2 as a horizontal strip, with the tile grid motif.
Callout: 13 features per tile, cosine kNN, cross-validated (up to 5 folds) in
the Model Lab. Visual: the 20×20 grid from `qa-evidence/pass2-label.png` plus the
result overlay from `pass2-analysis.png`.

**Slide 5 — The console.**
*Nine tabs, one field notebook.*
A 3×3 grid of tab names with one-line descriptions (section 4.3), screenshot of
Operations and Model Lab. Emphasise: it runs in a browser on a field laptop, no
build step, installable as a PWA.

**Slide 6 — Geospatial truth.**
*The map is not decoration.*
Bullets: 11 drawable agronomy layers; OSM search and features proxied through
the server; Sentinel-2 scenes fetched as windows, not downloads; elevation and
slope from Copernicus DEM; weather for any date since 1940. One honest line:
Windy is the map, the archive is the numbers.

**Slide 7 — AI with a contract.**
*Bring your own model; the console speaks one schema.*
Bullets: generic JSON or OpenAI-compatible endpoint; the model returns health,
weed area, soil quality; species identification is a second, local model;
unreachable model returns 502, never a guess. Visual: `qa-evidence/tab-ai.png`.

**Slide 8 — Sensors, live. (the demo slide)**
*A probe packet changes the field verdict in one second.*
Two-column: left, the anatomy of a packet — device id, token, ten metrics,
clamping, liveness windows; right, the Sensors screenshot showing CROP and SOIL
strips with `LIVE` pills. Say the flow aloud: token → ingest → per-metric merge
→ soil index → workflow invalidation → SSE push to every open console. Mention
the **Test packet** button as the one-press connectivity proof, and that a new
reading re-runs only three workflow nodes.

**Slide 9 — How we work.**
*Honest by construction.*
Four rules with one proof each: no synthetic data (sanitizer on boot); every
number names its source (`moisture 26.4% (S-0d15ca)`); missing data is loud
(nulls and 409s, not defaults); tests assert the rules (75 green tests, the
invalidation set, the Windy split). Close with the limits list from section 10
in one line: single-tenant, no database, kNN quality depends on your labels.

**Slide 10 — Where it goes / close.**
*Next: multi-date composites, calibrated yield, deep segmentation.*
Bullets from the roadmap: time-series automation, multi-date Sentinel
composites, a U-Net/YOLO-seg loader behind the existing registry, PDF field
reports, persistence and a job queue. Final line: "Point it at your field, label
twenty tiles, and the next photo is an answer."
Visual: console home with the two demo fields.

---

## 10. Limits you must state on slide 9 (verbatim-safe)

- **No authentication or multi-tenancy.** Ingest is token-gated per site, but the
  console itself is single-user. Put it behind TLS and an authenticating proxy
  before exposing it.
- **No database.** State is JSON on disk; that is why it is easy to run and why
  it is not yet a fleet product.
- **kNN quality equals label quality.** The demo model is tiny; its reported
  cross-validation numbers are low and shown as they are.
- **Sentinel-2 optical only** for scene ingestion; Sentinel-1 SAR scenes are
  searched but not turned into indices yet.
- **One window per request.** No automated multi-date compositing yet — the
  pieces exist (`fetch`, then time series) but nothing chains them.
- **Public catalogue instances are best-effort.** An unusual request can be slow;
  point the STAC URL at a private catalogue for production.
- **Single-scene analyses are indicative.** Real agronomic conclusions need
  multiple dates, ground truth and calibrated thresholds.

---

## 11. Delivery checklist

Assets to use (all real captures in `qa-evidence/`):

`tab-ops.png` · `pass2-label.png` · `pass2-ai.png` · `pass2-analysis.png` ·
`pass2-geo.png` · `sensors-crop-soil.png` (new — crop and soil strips with live
sensors) · `pass2-workflows-after.png` · `tab-lab.png` · `tab-applications.png`.

Before you call the deck finished:

- [ ] Exactly 10 slides, title first, close last.
- [ ] Every number traceable to section 8 — no invented metrics.
- [ ] Slide 8 names the four things a viewer would ask about: token, clamping,
      liveness, and what a packet changes.
- [ ] Slide 9 states at least three real limits.
- [ ] Architecture diagram on slide 3 and pipeline diagram on slide 4 are
      legible at presentation size (minimum 18 pt).
- [ ] No stock photo of a tractor. Screenshots and diagrams only.
- [ ] Speaker notes exist for all ten slides and fit 60–90 seconds each.
- [ ] Read it once as the agronomist: does anything claim more than the console
      can show on screen? If so, cut it.

---

## 12. One-line summaries, if the deck needs a tagline

- "A field is a grid, not an average."
- "Every number in this console can name where it came from."
- "The map is Windy's; the measurements are ours."
- "Label twenty tiles. The next photo is an answer."
