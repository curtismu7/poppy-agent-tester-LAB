#!/usr/bin/env python3
"""Runs take.py with a lab guard, so a lab that disappears mid-take can never leave a half-run in a video.

Why: on 2026-11-22 all four lab containers were removed in the middle of a take (cause not confirmed; the shelf was at its 10-demo cap). The take kept
going against a dead lab and would have produced a video of failed calls. This wrapper:
  1. makes sure the lab is healthy before the take starts (starts it with the shelf's own start command, `docker compose up -d`, if it is not);
  2. watches the lab's /api/health every few seconds while the take runs;
  3. if the lab goes away: stops ONLY its own take (never by name), brings the lab back, moves the partial work dir aside as <dir>-aborted-N,
     and starts the take again from the beginning (at most MAX_ATTEMPTS), because a run cut in half is never kept.
It touches only video/. It does not change the lab or the shelf, and it never stops anything.

Usage: HEADLESS_REAL=1 PROFILE=monitor SEGMENT=main python3 video/guarded_take.py <work-dir>
Env:   APP_URL (default http://localhost:6881), LAB_DIR (the lab's compose dir), MAX_ATTEMPTS (default 3), HEALTH_EVERY (seconds, default 5)
"""
import os, shutil, signal, subprocess, sys, threading, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = os.environ.get("APP_URL", "http://localhost:6881").rstrip("/")
LAB_DIR = os.environ.get("LAB_DIR", str(Path.home() / "Development/AI-DEMO-Standalone/standalone/privilege-a2a-anthropic-demo-LAB"))
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))
HEALTH_EVERY = float(os.environ.get("HEALTH_EVERY", "5"))
MISSES = 2   # consecutive failed checks before the lab counts as gone (one slow reply is not an outage)


def lab_healthy(url=APP, timeout=4):
    try:
        with urllib.request.urlopen(url + "/api/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def start_lab(lab_dir=LAB_DIR, url=APP, wait=120):
    """The shelf's own start command (docker compose up -d), then wait for health. Returns True when healthy."""
    subprocess.run(["docker", "compose", "up", "-d"], cwd=lab_dir, capture_output=True, text=True, timeout=300)
    end = time.time() + wait
    while time.time() < end:
        if lab_healthy(url): return True
        time.sleep(3)
    return False


def run_guarded(cmd, work, health=lab_healthy, start=start_lab, max_attempts=MAX_ATTEMPTS, every=HEALTH_EVERY, misses=MISSES, log=print):
    """Returns the child's exit code of the first attempt that finished with the lab healthy throughout; non-zero when every attempt lost the lab."""
    work = Path(work)
    for attempt in range(1, max_attempts + 1):
        if not health() and not start():
            log(f"guard: the lab is not healthy and could not be started (attempt {attempt}); giving up"); return 3
        if work.exists():   # an earlier partial run is moved aside, never mixed into a new take
            n = 1
            while Path(f"{work}-aborted-{n}").exists(): n += 1
            shutil.move(str(work), f"{work}-aborted-{n}")
        child = subprocess.Popen(cmd, start_new_session=True)   # its own process group: we signal exactly this take, nothing else
        lost = threading.Event(); done = threading.Event()
        def watch():
            bad = 0
            while not done.wait(every):
                bad = 0 if health() else bad + 1
                if bad >= misses:
                    lost.set(); return
        t = threading.Thread(target=watch, daemon=True); t.start()
        while child.poll() is None and not lost.is_set():
            time.sleep(0.5)
        done.set()
        if lost.is_set() and child.poll() is None:
            log(f"guard: the lab went away during attempt {attempt}; stopping this take (pid {child.pid}) and bringing the lab back")
            try: os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait()
            continue
        if not health():   # the take ended but the lab is gone: do not trust it
            log(f"guard: the take ended on attempt {attempt} but the lab is not healthy; the take is not kept")
            continue
        return child.returncode
    log(f"guard: no attempt kept the lab healthy for a whole take ({max_attempts} tried); nothing was kept")
    return 4


def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    work = Path(sys.argv[1]).resolve()
    take = HERE / "take.py"
    runner = HERE / "a2a_video_take.py"   # a name of our own so another session's cleanup of "take.py" can never match it
    if not runner.exists() or runner.read_bytes() != take.read_bytes(): shutil.copyfile(take, runner)
    sys.exit(run_guarded([sys.executable, str(runner), str(work)], work, log=lambda m: print(m, flush=True)))


if __name__ == "__main__":
    main()
