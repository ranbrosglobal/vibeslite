#!/usr/bin/env bash
# ============================================================================
#  ui_sweep.sh — A-to-Z browser sweep of the Crop AI console.
#
#  Drives a real Chromium session (agent-browser) through all nine tabs and
#  every actionable button, capturing, per action:
#    - the click return code (did the element exist and get clicked?)
#    - the #toast text the app shows afterwards (the app's own verdict)
#    - a PNG screenshot for the visual record
#  Console errors are checked per tab. Nothing invented: what the log says is
#  what the app answered.
#
#  Usage:  bash tools/ui_sweep.sh [session-name]
#  Requires the console running (starts itself if needed) at 127.0.0.1:5177.
# ============================================================================
set -uo pipefail
S="${1:-vibes-a2z}"
BASE=http://127.0.0.1:5177
EV=qa-evidence
LOG=$EV/ui-sweep.log
PHOTO=qa-evidence/assets/Maize_field.jpg
mkdir -p "$EV"
: > "$LOG"

AB() { agent-browser --session "$S" "$@" 2>&1; }
log() { echo "$*" | tee -a "$LOG"; }

toast_text() {
  AB eval '(() => { const t = document.querySelector("#toast"); return t ? (t.textContent || "").trim() : ""; })()' \
    | tr -d '\n' | sed 's/^"//; s/"$//'
}

click() {  # click <selector> <label> [wait-seconds]
  local sel="$1" label="$2" wait="${3:-1.5}"
  local rc
  AB click "$sel" >/dev/null 2>&1; rc=$?
  sleep "$wait"
  log "  click ${label} [${sel}] rc=${rc} :: toast=\"$(toast_text)\""
}

shot() { AB screenshot "$EV/$1" >/dev/null 2>&1 && log "  [shot] $1"; }

errors_here() {  # prints only real error lines
  AB errors 2>&1 | grep -vE '^\s*$|No (page )?errors|✓|errors found: 0' | head -5
}

tab() {  # tab <name>
  AB click "[data-tab=\"$1\"]" >/dev/null 2>&1
  sleep 1.2
  local e; e=$(errors_here)
  log ""
  log "── TAB $1 ──${e:+ CONSOLE ERRORS:
$e}"
  shot "tab-$1.png"
}

# ── ensure the console is up ───────────────────────────────────────────────
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")
if [ "$code" != "200" ]; then
  log "console not running — starting it"
  (cd "$(dirname "$0")/.." && .venv/bin/python tools/cropai_server.py start >/dev/null 2>&1)
  sleep 3
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")
fi
log "console health: $code   session: $S"

AB open "$BASE" >/dev/null 2>&1
sleep 2
if [ "$(AB get url 2>/dev/null | tail -1)" = "" ]; then
  log "FATAL: browser session did not open"; exit 1
fi

# ── 1. ops: camera modal + real-photo ingest ───────────────────────────────
tab ops
click '#btn-camera' 'open camera modal' 1.6
log "  camera modal visible: $(AB is visible '#camera-modal' 2>&1 | tail -1)"
shot 'ops-camera-open.png'
click '#btn-capture' 'capture frame (no camera in headless)' 2.5
click '#btn-cam-close' 'close camera modal' 1.0
log "  camera modal hidden again: $(AB is visible '#camera-modal' 2>&1 | tail -1)"

log "  -- ingest REAL photo (Wikimedia maize field, 1024px) --"
AB upload '#file-input' "$PHOTO" >/dev/null 2>&1
sleep 6
log "  ingest toast=\"$(toast_text)\""
shot 'ops-after-ingest.png'
log "  field count now: $(curl -s "$BASE/api/fields" | grep -o '"fieldId"' | wc -l | tr -d ' ')"

# ── 2. analysis: the freshly ingested field ────────────────────────────────
tab analysis
NEWFIELD=$(curl -s "$BASE/api/fields" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const fs=j.fields||j;console.log(fs[fs.length-1].fieldId)})')
log "  newest field: $NEWFIELD"
click "#btn-predict" 'analyze newest field' 8
log "  distribution visible: $(AB get text '#dist' 2>&1 | tr '\n' ' ' | head -c 160)"
click '#btn-geotag-show' 'show geotag form' 1.0
AB fill '#geo-lat' '52.6250' >/dev/null 2>&1
AB fill '#geo-lon' '5.6550' >/dev/null 2>&1
AB fill '#geo-width' '120' >/dev/null 2>&1
click '#btn-geotag' 'geotag the new field at real farmland' 3
log "  field gps now: $(curl -s "$BASE/api/fields/$NEWFIELD" | grep -o '"lat":[0-9.]*' | head -1)"
click '#btn-geojson' 'export GeoJSON' 1.5
click '#btn-geo-gps' 'use device GPS (permission test)' 2
shot 'analysis-done.png'

# ── 3. label: label tiles, then train from labels ──────────────────────────
tab label
AB click '.tab.active .cls-btn, #tab-label button:has-text("Healthy")' >/dev/null 2>&1
sleep 1
log "  label buttons present: $(AB get count '#tab-label button' 2>&1 | tail -1)"
click '#btn-from-labels' 'train dataset from labels' 4
click '#btn-train' 'train + cross-validate' 5

# ── 4. lab: metrics panel ─────────────────────────────────────────────────
tab lab
log "  models: $(AB get count '#model-table tbody tr' 2>&1 | tail -1)"
click '#tab-lab button:has-text("Metrics")' 'open metrics for last model' 1.5
log "  metrics card: $(AB get text '#metrics-overall' 2>&1 | tr '\n' ' ' | head -c 200)"

# ── 5. ai: provider + vision + species identification ─────────────────────
tab ai
click '#btn-ai-test' 'test AI connection' 4
click '#btn-ai-report' 'load cached report' 4
click '#btn-ai-run' 'run vision analysis' 25
click '#btn-ai-save' 'save AI settings' 2
click '#btn-ai-id-test' 'test species identification' 25
click '#btn-ai-id-save' 'save identification config' 2
click '#btn-ai-copy' 'copy snippet' 1.5
shot 'ai-done.png'

# ── 6. sensors: weather, device lifecycle, endpoint snippet ───────────────
tab sensors
click '#btn-refresh-wx' 'refresh live weather' 5
log "  weather: $(AB get text '#wx-now, #wx-panel, #weather-now' 2>&1 | tr '\n' ' ' | head -c 160)"
click '#btn-add-sensor' 'register a sensor (token shown once)' 2.5
click '#btn-copy-snippet' 'copy ingest snippet' 1.5
log "  devices on newest field: $(curl -s "$BASE/api/sensors/sites" | grep -o "\"deviceCount\":[0-9]*" | head -3 | tr '\n' ' ')"
shot 'sensors-done.png'

# ── 7. workflows: run a network workflow, history, clear ──────────────────
tab workflows
click '#tab-workflows button:has-text("Imagery acquisition")' 'run imagery-window workflow' 30
click '#tab-workflows button:has-text("Sentinel-1 SAR")' 'fetch Sentinel-1 SAR' 15
click '#tab-workflows button:has-text("Terrain + slope")' 'fetch terrain + slope' 15
click '#tab-workflows button:has-text("Weather cross-check")' 'weather cross-check' 15
click '#btn-wf-history' 'refresh run history' 2
log "  history rows: $(AB get count '#wf-history tbody tr, #wf-runs tbody tr' 2>&1 | tail -1)"
shot 'workflows-done.png'
click '#btn-wf-clear' 'clear workflow history' 2

# ── 8. geo: locate ────────────────────────────────────────────────────────
tab geo
AB set geo 52.6250 5.6550 >/dev/null 2>&1
click '#btn-locate' 'locate (device geolocation)' 3
log "  map tiles loaded: $(AB get count '.leaflet-tile-loaded' 2>&1 | tail -1)"

# ── 9. applications: proof the grid rendered ──────────────────────────────
tab applications
log "  application cards: $(AB get count '#apps-grid > *' 2>&1 | tail -1)"

log ""
log "── FINAL ERROR CHECK ──"
log "$(errors_here)"
log "sweep complete: $(date -u +%FT%TZ)"
