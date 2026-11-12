"""Ollama helper: local vision model on :11434 for plant species identification.

Shell-spawned processes die when a tool call exits here, so the server is
launched detached (start_new_session=True), same as cropai_server.py.

Usage:
  .venv/bin/python tools/ollama_server.py        # start if not running
  .venv/bin/python tools/ollama_server.py stop
  .venv/bin/python tools/ollama_server.py status
"""
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx

LOG = Path("/tmp/vibes-ollama.log")
URL = "http://localhost:11434"
MODEL = "qwen2.5vl:3b"  # default identify model (matches ai-config.json)
VISION = ("qwen2.5vl", "moondream", "llava", "minicpm-v", "gemma3")
OLLAMA = shutil.which("ollama") or "/opt/homebrew/bin/ollama"


def is_up() -> bool:
    try:
        r = httpx.get(f"{URL}/api/tags", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def has_model() -> bool:
    try:
        r = httpx.get(f"{URL}/api/tags", timeout=3)
        models = [m.get("name", "") for m in r.json().get("models", [])]
        return any(m.split(":")[0] in VISION for m in models)
    except Exception:
        return False


def stop():
    out = subprocess.run(["lsof", "-ti", "tcp:11434"], capture_output=True, text=True)
    for pid in out.stdout.split():
        subprocess.run(["kill", pid])
    if out.stdout.strip():
        time.sleep(1.0)
    print("stopped" if out.stdout.strip() else "was not running")


def start():
    if not Path(OLLAMA).exists():
        print(f"ollama not installed (expected at {OLLAMA})")
        return
    if is_up():
        print(f"already running: {URL}")
    else:
        LOG.write_text("")
        log = open(LOG, "w")
        subprocess.Popen(
            [OLLAMA, "serve"],
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        for _ in range(40):
            time.sleep(0.5)
            if is_up():
                print(f"running: {URL} (log {LOG})")
                break
        else:
            print(f"FAILED to start — log tail:\n{LOG.read_text()[-2000:]}")
            return
    # any vision model works; these are the two we ship defaults for
    try:
        r = httpx.get(f"{URL}/api/tags", timeout=3)
        names = [m.get("name", "") for m in r.json().get("models", [])]
    except Exception:
        names = []
    vision = [n for n in names if n.split(":")[0] in VISION]
    if vision:
        print(f"vision model ready: {vision[0]}")
    else:
        print(f"no vision model yet — run: ollama pull {MODEL}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "start"
    if cmd == "stop":
        stop()
    elif cmd == "status":
        up = is_up()
        print(f"{'up' if up else 'down'}; model {'ready' if has_model() else 'missing'}")  # any known vision model counts
    else:
        start()
