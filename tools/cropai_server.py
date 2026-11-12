"""Relaunch helper: detached Crop AI backend on :5177.

Rationale: in this environment, shell-spawned processes die when the tool call
exits; a Python subprocess with start_new_session=True survives.

Usage:
  .venv/bin/python tools/cropai_server.py        # check + start if not running
  .venv/bin/python tools/cropai_server.py stop   # stop it
  .venv/bin/python tools/cropai_server.py status # status only
"""
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
CROP_AI = ROOT / "crop-ai"
LOG = Path("/tmp/vibes-cropai.log")
URL = "http://localhost:5177/api/health"


def is_up() -> bool:
    try:
        r = httpx.get(URL, timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def mock_up() -> bool:
    try:
        r = httpx.get("http://localhost:5199/health", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def stop_mock():
    out = subprocess.run(["lsof", "-ti", "tcp:5199"], capture_output=True, text=True)
    for pid in out.stdout.split():
        subprocess.run(["kill", pid])


def stop():
    out = subprocess.run(["lsof", "-ti", "tcp:5177"], capture_output=True, text=True)
    for pid in out.stdout.split():
        subprocess.run(["kill", pid])
    if out.stdout.strip():
        time.sleep(1.0)
    print("stopped" if out.stdout.strip() else "was not running")


def start():
    if not is_up():
        LOG.write_text("")
        log = open(LOG, "w")
        subprocess.Popen(
            ["node", "server.js"],
            cwd=str(CROP_AI),
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        for _ in range(60):
            time.sleep(0.5)
            if is_up():
                print(f"running: http://localhost:5177 (log {LOG})")
                break
        else:
            print(f"FAILED to start — log tail:\n{LOG.read_text()[-2000:]}")
            return
    else:
        print("already running: http://localhost:5177")
    # The reference crop-vision model is part of the same demo story: bring it
    # up with the console (detached the same way) unless it is already there.
    if not mock_up():
        mock_log = open("/tmp/vibes-mockai.log", "w")
        subprocess.Popen(
            ["node", "mock-ai-model.js"],
            cwd=str(CROP_AI),
            stdout=mock_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        for _ in range(10):
            time.sleep(0.5)
            if mock_up():
                break
        print("mock-ai :5199 " + ("running" if mock_up() else "FAILED (see /tmp/vibes-mockai.log)"))
    else:
        print("mock-ai :5199 already running")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "start"
    if cmd == "stop":
        stop()
        stop_mock()
    elif cmd == "status":
        up = is_up()
        mock = mock_up()
        print(f"console {'up' if up else 'down'}; mock-ai {'up' if mock else 'down'}")
    else:
        start()
