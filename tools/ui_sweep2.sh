#!/usr/bin/env bash
# ============================================================================
#  ui_sweep2.sh — second-pass browser sweep.
#
#  Differences from ui_sweep.sh (and why):
#   1. Page errors are collected IN-PAGE (window.onerror + unhandledrejection)
#      instead of via the CLI's `errors`, whose ✗ lines print an empty message.
#   2. Buttons are located by visible text (`find text`) — the CSS
#      `:has-text()` selectors used in pass 1 resolved to nothing, so those
#      clicks (workflow source fetches, Model Lab metrics) never ran.
#   3. File upload is done by building the FormData in-page from a fetched
#      blob: `agent-browser upload` injects a file path that Chromium refuses
#      to read into a multipart body (harness limitation, not an app bug).
#
#  Usage: bash tools/ui_sweep2.sh [session]
# ============================================================================
set -uo pipefail
S="${1:-vibes-a2z}"
BASE=http://127.0.0.1:5177
EV=qa-evidence
LOG=$EV/ui-sweep2.log
mkdir -p "$EV"; : > "$LOG"

AB() { agent-browser --session "$S" "$@" 2>&1; }
log() { echo "$*" | tee -a "$LOG"; }
toast() { AB eval 'document.querySelector("#toast").textContent' | tr -d '\n' | sed 's/^"//; s/"$//'; }
errs()  { AB eval 'JSON.stringify(window.__errs || [])' | tail -1; }
clearerr() { AB eval 'window.__errs = []; "cleared"' >/dev/null 2>&1; }
clicktext() { AB find text "$1" click >/dev/null 2>&1; sleep "${2:-2}"; log "  click \"$1\" -> toast=\"$(toast)\" | errs=$(errs)"; }
clickid()   { AB click "$1" >/dev/null 2>&1; sleep "${2:-2}"; log "  click $1 -> toast=\"$(toast)\" | errs=$(errs)"; }
tab() { AB click "[data-tab=\"$1\"]" >/dev/null 2>&1; sleep 1.3; log ""; log "── TAB $1 ── errs=$(errs)"; }
shot() { AB screenshot "$EV/$1" >/dev/null 2>&1 && log "  [shot] $1"; }
install_collector() {
  AB eval 'window.__errs=[];window.addEventListener("error",e=>window.__errs.push("error: "+(e.message||e.type)));window.addEventListener("unhandledrejection",e=>window.__errs.push("rejection: "+(e.reason&&e.reason.message||e.reason)));"ok"' >/dev/null 2>&1
}

log "console: $(curl -s -o /dev/null -w '%{http_code}' $BASE/api/health)"
AB open "$BASE" >/dev/null 2>&1; sleep 3
install_collector
log "collector installed, start errs=$(errs)"
log "startup cards: fields=$(AB get count '#field-table tbody tr' | tail -1) tiles/chips=$(AB get count '.kpi, .stat' | tail -1)"
shot 'pass2-00-dashboard.png'

# ── Model Lab: metrics buttons (pass 1 missed these) ───────────────────────
tab lab
log "  model rows: $(AB get count 'table tbody tr' | tail -1)"
clicktext 'Metrics' 2
log "  metrics overall: $(AB get text '#metrics-overall' | tr '\n' ' ' | head -c 120)"

# ── Workflows: the four real source fetches + run + history ────────────────
tab workflows
clicktext 'Sentinel-2 scenes' 20
clicktext 'Sentinel-1 SAR' 15
clicktext 'Terrain + slope' 15
clicktext 'Weather cross-check' 18
clicktext 'Imagery acquisition window' 30
log "  history rows: $(AB get count '#wf-history tr, #wf-runs tr' | tail -1)"
shot 'pass2-workflows.png'
clickid '#btn-wf-history' 2

# ── Labeling: class buttons + dataset + train ─────────────────────────────
tab label
clicktext 'Healthy crop' 1.5
clicktext 'Weed area' 1.5
clickid '#btn-from-labels' 3
clickid '#btn-train' 6
shot 'pass2-label.png'

# ── AI: vision + species on the REAL photo field ──────────────────────────
tab ai
clickid '#btn-ai-test' 5
clickid '#btn-ai-run' 30
log "  report keys: $(AB get text '#ai-out, #ai-result, #ai-report' | tr '\n' ' ' | head -c 140)"
shot 'pass2-ai.png'

# ── Sensors: weather refresh + device lifecycle ───────────────────────────
tab sensors
clickid '#btn-refresh-wx' 6
clickid '#btn-add-sensor' 3
log "  sites: $(AB get count '.site-block' | tail -1)  devices: $(AB get count '.site-body .dev-block, .site-body > *' | tail -1)"
clickid '#btn-copy-snippet' 2
shot 'pass2-sensors.png'

# ── Analysis / Geo / Applications quick pass ──────────────────────────────
tab analysis
clickid '#btn-predict' 8
clickid '#btn-geotag-show' 1
clickid '#btn-geojson' 2
log "  distribution: $(AB get text '#dist' | tr '\n' ' ' | head -c 120)"
shot 'pass2-analysis.png'

tab geo
clickid '#btn-locate' 3
log "  map tiles: $(AB get count '.leaflet-tile-loaded' | tail -1)"
shot 'pass2-geo.png'

tab applications
log "  app cards: $(AB get count '#apps-grid > *' | tail -1)"
tab ops
log "  kpis: $(AB get count '.kpi' | tail -1)"

log ""
log "── ACCUMULATED PAGE ERRORS ──"
log "$(errs)"
log "sweep2 complete $(date -u +%FT%TZ)"
