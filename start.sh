#!/usr/bin/env bash
# ============================================================================
#  Vibes Lite — ONE command to run the whole Crop AI system.
#
#    ./start.sh                 backend API + web console on http://localhost:5177
#    ./start.sh --mock-ai       also starts the reference crop-vision model on :5199
#    PORT=8080 ./start.sh       serve on a different port
#
#  crop-ai/server.js serves BOTH the JSON API and the static web console from a
#  single Node process, so there is no separate frontend dev server to run.
#
#  External AI is configured either here:
#    AI_PROVIDER=generic AI_API_URL=https://gpu.example.com/predict AI_MODEL=crop-vision ./start.sh
#  or at runtime from the "AI Model" tab in the console.
#
#  Plant species identification uses a LOCAL Ollama vision model (qwen2.5vl:3b):
#    ollama pull qwen2.5vl:3b       # one-time download (~3.2 GB)
#    ./start.sh                     # starts 'ollama serve' automatically
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

MOCK_AI=0
for arg in "$@"; do
  case "$arg" in
    --mock-ai) MOCK_AI=1 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required (>= 18). Install from https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "error: node >= 18 required, found $(node -v)" >&2
  exit 1
fi

if [ ! -d crop-ai/node_modules ]; then
  echo "[start] installing backend dependencies (first run only)..."
  npm --prefix crop-ai install --no-audit --no-fund
fi

cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "$MOCK_AI" -eq 1 ]; then
  echo "[start] starting reference crop-vision model on :5199 (test harness)"
  node crop-ai/mock-ai-model.js &
  MOCK_PID=$!
  sleep 1
  if [ -z "${AI_PROVIDER:-}" ] && [ ! -f crop-ai/data/ai-config.json ]; then
    export AI_PROVIDER=generic
    export AI_API_URL="http://localhost:5199/predict"
    export AI_MODEL="mock-crop-vision/1.0"
  fi
fi

# Plant species identification runs on a local Ollama vision model. Start the
# server when it is installed; never fail the console start over it.
if command -v ollama >/dev/null 2>&1; then
  if ! curl -s -m 1 http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo "[start] starting local Ollama server (:11434) for species identification"
    (nohup ollama serve >> /tmp/vibes-ollama.log 2>&1 &) || true
    sleep 1
  fi
fi

SERVE_PORT="${PORT:-5177}"
case "$SERVE_PORT" in ''|*[!0-9]*) SERVE_PORT=5177 ;; esac
[ "$SERVE_PORT" -le 0 ] && SERVE_PORT=5177

echo "[start] Crop AI backend + web console -> http://localhost:${SERVE_PORT}"
exec node crop-ai/server.js