# A-to-Z QA pass — Crop AI console

**Date:** 8 October 2026 · **Scope:** every page, feature, button and backend
route of the Crop AI console, plus the deployment entry point · **Verdict:**
everything tested passes; **two real bugs were found and fixed** and two
smaller demo-quality issues were improved along the way.

Nothing below is asserted without an artifact behind it: each section names the
command that produced the result and where the raw output lives.

---

## 1. Results by layer

| Layer | Command | Result |
|---|---|---|
| Backend route checks | `node tools/qa_sweep.mjs` | **73/73, 0 FAIL** — all 46 console routes: success paths, error paths, `401` device auth, the data-integrity contract, workflow caching, identify round-trips |
| Console unit suite | `node --test crop-ai/server.test.js` | **18/18, exit 0** (~7 s, includes one live-network test) |
| Serverless entry | `node tools/vercel_harness.js` | **15/15, exit 0** — no auto-listen, `/tmp` cold-start seed, API + static serving, demo routes `404` |
| Browser, pass 1 | `bash tools/ui_sweep.sh` | 9 tabs clicked with real input, one screenshot per tab, per-action toast captured (`qa-evidence/ui-sweep.log`) |
| Browser, pass 2 | `bash tools/ui_sweep2.sh` | all nine tabs + every button; **zero page errors** from an in-page `window.onerror` / `unhandledrejection` collector (`qa-evidence/ui-sweep2.log`) |
| SSE bus | live `curl -N /api/events` while triggering actions | frames received: `hello`, `sensors`, `trained`, `dataset-updated`, `device-removed`, 5 × `workflow-node`, 1 × `workflow-run` |
| Python platform | `pytest tests -q` | **not re-run in this pass** — no Python file was touched; the 143-green run recorded earlier today still stands |

### What the sweeps actually drove (UI)

Operations (camera modal, ingest) · Labeling (label tiles, build dataset, train)
· Model Lab (metrics, confusion matrix) · AI Model (connection test, cached
report, vision analysis, settings save, species test, snippet copy) · Analysis
(predict, geotag, GeoJSON export, device-GPS) · Geo Map (locate, map tiles
render) · Sensors (weather refresh, register sensor, ingest snippet, endpoint)
· Workflows (four connector fetches, Run, Re-run forced, history, clear) ·
Applications (8 cards render).

Measured along the way: workflow **Run → “0 node(s) ran, 3 reused”** on a warm
cache; **Re-run forced → “3 node(s) ran, 0 reused” in 1,745 ms**; a fresh
`local-agronomy` run **“3 ran / 2 reused”**; start and end of every run written
to the run-history table.

---

## 2. Bugs found and fixed

### 2.1 Sensors tab crashed for any field without GPS *(real bug, fixed)*

`renderSites()` formatted `s.gps.lat.toFixed(4)` whenever a `gps` object was
present — but a field that has never been georeferenced still returns
`gps: { lat: null, lon: null }`. The render threw
`Cannot read properties of null (reading 'toFixed')`, which took out the whole
site list **and** made both the weather-refresh and add-sensor buttons fail with
the same message.

*Found by:* `tools/ui_sweep.sh` (sensors tab, `#btn-refresh-wx`).
*Fix:* guarded in `crop-ai/public/app.js`, with an explicit
`no GPS — geotag to unlock weather & map` label; the same guard was applied to
the Geo Map status chip and to the identification-history coordinates.
*Re-verified:* `#btn-refresh-wx` now returns **“Live weather refreshed -
Open-Meteo”**, 2 site blocks render, `window.__errs` is `[]`
(`qa-evidence/sensors-after-fix.png`).

### 2.2 Species identification could never succeed from field imagery *(real bug, fixed)*

Every identification call — the AI-tab test round-trip and the map-tile
“Identify here” path — sent the model a **50 px map tile**. No vision model can
name a plant from a thumbnail: qwen2.5vl:3b answered “no species information”,
or rambled until the 120 s timeout killed it (Ollama logged
`n_tokens = 1424, truncated`; the call returned `500 | 2m0s`).

*Fix:* new `speciesImagePayload()` builds the largest sensible view of the real
image — a square region centred on the requested tile (448 px) for tile
requests, the whole frame (512 px, box-average downscale) for the test
round-trip — and the OpenAI-compatible call is now bounded with `max_tokens`
(400 identify / 1600 crop) so a question cannot turn into an essay. The crop is
recorded with the stored entry, so provenance is checkable.
*Re-verified with a real photograph* (Wikimedia maize field, 1200×900):

| Call | Result | Latency |
|---|---|---|
| `POST /api/ai/test-identify` (full frame 512) | `ok:true` → **Rye Grass / Hordeum vulgare**, 0.85, traits + 2 ranked candidates, crop `full-frame` | 98,573 ms |
| `POST /api/ai/identify` `{fieldId,r:9,c:12}` (region 448 → crop `x425,y275,400×400`) | stored as `field-region` with crop provenance | 71,041 ms |

Both HTTP 200 through the local Ollama endpoint; the identification history now
holds 4 real entries (field region, 2 camera frames, 1 map tile).

### 2.3 Smaller demo-quality fixes

- **Workflow field selector** now labels each field `GPS` / `no GPS` and
  defaults to a georeferenced one. Previously the four connector buttons failed
  out of the box with “Field has no GPS georeference” when the newest upload
  happened to be the selected field.
- **`/api/train` deduplicates**: an unchanged dataset returns the existing model
  (`reused: true`, toast “Dataset unchanged — reusing model-…”) instead of
  stacking an identical model on every click. Verified in the browser: two
  clicks, model count 3 → 3.
- Identification entries and the console's activity feed now describe the source
  honestly (`field-region` vs `camera`).

---

## 3. Could not be verified here (and why)

| Item | Why |
|---|---|
| Live camera capture / “Identify plant” from a real lens | Headless Chromium denies `getUserMedia`: the app degrades correctly (`Camera unavailable: Permission denied`, modal closes) — the **success** path needs a machine with a camera |
| Device-GPS success path (`Use device GPS`, `Locate me`) | Same: the harness cannot grant geolocation permission, so only the denial path is exercised (“GPS denied” / “Location denied”) |
| A Playwright spec inside the repo's own test runner | Not written: the browser sweeps drive the **agent-browser** CLI instead, so this stays an open CP5 item (recorded in the roadmap) |
| A real Vercel deployment | No account/link: `tools/vercel_harness.js` simulates the cold start locally (15/15) and the upload path is unchanged |
| Docker | Daemon not running (unchanged from the earlier pass) |

**Harness artifact, not an app bug:** `agent-browser upload '#file-input' …`
injects a file path that Chromium refuses to read into a multipart body, so the
page reports `Failed to fetch`. The same 499 KB photo uploads fine when the
`FormData` is built in-page (verified), and `curl -F` uploads fine too — the
server log proves the injected-file request never arrives. Use the in-page
method when scripted uploads are needed.

---

## 4. Test fixtures and state

- Fixtures: three photographs downloaded from Wikimedia Commons into
  `qa-evidence/assets/` — `Maize_field.jpg`, `Wheat_field.jpg`, `Rice_leaf.jpg`
  (via `commons.wikimedia.org/wiki/Special:FilePath/<name>?width=1024`). They
  are **test inputs only**; their licenses were not verified, so do not ship
  them as product assets without checking each file's Commons page.
- Demo state restored after testing: **2 fields** (`upload-test` — manual GPS,
  20×20 grid; `real-drone-test` — EXIF GPS, 4×4 grid), **4 devices across 2
  sites**. Test uploads, test sensors and duplicate models created during the
  sweeps were deleted.
- Evidence: 30 screenshots + both sweep logs + this report in `qa-evidence/`.

---

## 5. Reproduce

```bash
./start.sh                                     # or: .venv/bin/python tools/cropai_server.py start
node tools/qa_sweep.mjs                        # 73 backend checks
node --test crop-ai/server.test.js             # 18 unit tests
node tools/vercel_harness.js                   # 15 serverless checks
bash tools/ui_sweep.sh vibes-a2z               # browser pass 1  (needs agent-browser)
bash tools/ui_sweep2.sh vibes-a2z              # browser pass 2, in-page error collector
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"fieldId":"<a field with GPS>"}' localhost:5177/api/ai/test-identify   # species (60–120 s)
```
