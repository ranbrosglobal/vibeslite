#!/usr/bin/env bash
# ============================================================================
#  Vibes Lite — ONE command for the whole platform.
#
#    npm run dev            (or ./dev.sh)
#
#  Boots every surface this repo ships, in one terminal:
#
#    Crop AI console    http://localhost:5177   Crop AI API + web console (Node)
#    Vibes Lite API     http://localhost:8000   FastAPI, /docs interactive
#    Vibes Lite web     http://localhost:5173   React + Vite dashboard
#    Crop-vision model  http://localhost:5199   reference AI endpoint the console calls
#
#  Ports: CONSOLE_PORT (5177) · API_PORT (8000) · WEB_PORT (5173) · MOCK_AI_PORT (5199)
#  Logs:  .dev/logs/<service>.log
#
#  Console only (the original entry point):  ./start.sh     (or npm start)
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[dev] unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

# The console keeps honouring PORT= for compatibility, but an ambient PORT=0
# (common in CI and editor task runners) must not become an ephemeral port we
# can never print a usable URL for. Anything unusable falls back to the default.
CONSOLE_PORT="${CONSOLE_PORT:-${PORT:-5177}}"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-5173}"
AI_PORT="${MOCK_AI_PORT:-5199}"
case "$CONSOLE_PORT" in ''|*[!0-9]*|0) CONSOLE_PORT=5177 ;; esac
case "$API_PORT" in ''|*[!0-9]*|0) API_PORT=8000 ;; esac
case "$WEB_PORT" in ''|*[!0-9]*|0) WEB_PORT=5173 ;; esac
case "$AI_PORT" in ''|*[!0-9]*|0) AI_PORT=5199 ;; esac
export MOCK_AI_PORT="$AI_PORT"

LOG_DIR=".dev/logs"
mkdir -p "$LOG_DIR"
: >"$LOG_DIR/console.log" 2>/dev/null || true

say() { printf '[dev] %s\n' "$*"; }
die() { printf '[dev] error: %s\n' "$*" >&2; exit 1; }

# --- preflight --------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node is required (>= 18): https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node >= 18 required, found $(node -v)"

# Refuse to fight an already-running server: we only ever stop what we start.
if command -v lsof >/dev/null 2>&1; then
  for pair in "console:$CONSOLE_PORT" "api:$API_PORT" "web:$WEB_PORT"; do
    name="${pair%%:*}"; port="${pair##*:}"
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      die "port $port ($name) is already in use — stop that process or pick another port"
    fi
  done
fi

# --- dependencies (first run only) -----------------------------------------
if [ ! -d crop-ai/node_modules ]; then
  say "installing console dependencies (first run)…"
  npm --prefix crop-ai install --no-audit --no-fund
fi

if [ ! -d frontend/node_modules ]; then
  say "installing dashboard dependencies (first run)…"
  if [ -f frontend/package-lock.json ]; then
    npm --prefix frontend ci --no-audit --no-fund
  else
    npm --prefix frontend install --no-audit --no-fund
  fi
fi

PY=".venv/bin/python"
NEED_PY_DEPS=0
if [ ! -x "$PY" ]; then
  command -v python3 >/dev/null 2>&1 || die "python3 is required for the Vibes Lite API"
  say "creating .venv (first run)…"
  python3 -m venv .venv
  NEED_PY_DEPS=1
fi
"$PY" -c 'import fastapi, uvicorn' >/dev/null 2>&1 || NEED_PY_DEPS=1
if [ "$NEED_PY_DEPS" -eq 1 ]; then
  say "installing API dependencies (first run, several GB of wheels)…"
  "$PY" -m pip install --quiet --upgrade pip
  "$PY" -m pip install --quiet -r backend/requirements.txt
fi

# Local Ollama, when installed, powers plant-species identification. Never fatal.
if command -v ollama >/dev/null 2>&1; then
  if ! curl -s -m 1 http://localhost:11434/api/tags >/dev/null 2>&1; then
    (nohup ollama serve >>/tmp/vibes-ollama.log 2>&1 &) || true
  fi
fi

# --- launch -----------------------------------------------------------------
PIDS=()
NAMES=()
LOGS=()

cleanup() {
  trap - EXIT INT TERM
  local i
  for i in "${!PIDS[@]}"; do kill "${PIDS[$i]}" 2>/dev/null || true; done
  for i in "${!PIDS[@]}"; do wait "${PIDS[$i]}" 2>/dev/null || true; done
  say "stopped."
}
trap cleanup EXIT
trap 'exit 130' INT TERM

start() { # name log-dir command...
  local name="$1" dir="$2"; shift 2
  NAMES+=("$name"); LOGS+=("$LOG_DIR/$name.log")
  ( cd "$dir" && exec "$@" ) >"$LOG_DIR/$name.log" 2>&1 &
  PIDS+=("$!")
}

start console . node crop-ai/server.js
start api     backend "$PWD/.venv/bin/python" -m uvicorn main:app --host 127.0.0.1 --port "$API_PORT"
start web     frontend ./node_modules/.bin/vite --port "$WEB_PORT" --strictPort

# The console calls a remote crop-vision model, and its saved config
# (crop-ai/data/ai-config.json) points at the bundled reference model below.
# Without it every AI request in the console fails with ECONNREFUSED, so it
# starts with the stack. A model already listening on the port is reused.
AI_INDEX=-1
if [ -f crop-ai/mock-ai-model.js ]; then
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$AI_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    say "crop-vision model already listening on :$AI_PORT — reusing it"
  else
    start aimodel . node crop-ai/mock-ai-model.js
    AI_INDEX=$(( ${#PIDS[@]} - 1 ))
  fi
fi

# Fail loudly if a service exits mid-startup, instead of leaving a half stack.
died() {
  local i="$1"
  printf '\n[dev] %s exited — shutting the stack down. Last lines of %s:\n' "${NAMES[$i]}" "${LOGS[$i]}" >&2
  tail -n 15 "${LOGS[$i]}" >&2 || true
  exit 1
}

wait_http() { # name url index
  local name="$1" url="$2" i="$3" code
  for _ in $(seq 1 120); do
    kill -0 "${PIDS[$i]}" 2>/dev/null || died "$i"
    code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$url" || true)"
    case "$code" in 2*|3*) printf '  ready  %-8s %s\n' "$name" "$url"; return 0 ;; esac
    sleep 0.5
  done
  printf '[dev] %s never answered %s. Last lines of %s:\n' "$name" "$url" "${LOGS[$i]}" >&2
  tail -n 15 "${LOGS[$i]}" >&2 || true
  exit 1
}

printf '\n[dev] Vibes Lite — starting every service\n'
wait_http console "http://127.0.0.1:${CONSOLE_PORT}/api/health" 0
wait_http api     "http://127.0.0.1:${API_PORT}/api/health"     1
wait_http web     "http://127.0.0.1:${WEB_PORT}/"               2
[ "$AI_INDEX" -lt 0 ] || wait_http aimodel "http://127.0.0.1:${AI_PORT}/health" "$AI_INDEX"

cat <<EOF

  Crop AI console    http://localhost:${CONSOLE_PORT}
  Vibes Lite API     http://localhost:${API_PORT}       docs: http://localhost:${API_PORT}/docs
  Vibes Lite web     http://localhost:${WEB_PORT}
  Crop-vision model  http://localhost:${AI_PORT}       health: http://localhost:${AI_PORT}/health

  Live logs: ${LOG_DIR}/{console,api,web,aimodel}.log    Ctrl-C stops all of them.

EOF

# Supervise: if one service dies, tear the whole stack down rather than
# leaving a dashboard talking to a backend that is no longer there.
while :; do
  for i in "${!PIDS[@]}"; do
    kill -0 "${PIDS[$i]}" 2>/dev/null || died "$i"
  done
  sleep 1
done
