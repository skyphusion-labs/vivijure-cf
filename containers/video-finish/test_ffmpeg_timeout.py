"""cf#571: a hung ffmpeg/ffprobe cannot hold a video-finish worker thread forever.

Drives the timeout path RED with a real long-sleep child (not a mock, not a real
1.2 GB encode). Asserts the named FfmpegTimeout, that it is distinguishable
from a normal non-zero exit, that the call returns inside the bound, and that
the process group is reaped. Also AST-scans production files so a new
unbounded subprocess.run cannot land silently.

Run:  python3 test_ffmpeg_timeout.py
Exits non-zero on any failed assertion. Stdlib + this dir; no ffmpeg needed.
"""
import ast
import os
import signal
import subprocess
import sys
import time

import ffmpeg_run as fr
import inspect_core as ic


def check(name, cond):
    if cond:
        print(f"  ok  {name}")
    else:
        print(f"FAIL  {name}")
        check.failed += 1
check.failed = 0


def _alarm(_signum, _frame):
    raise SystemExit("TEST HUNG: _run did not return inside the outer alarm")


def _unbounded_subprocess_runs(path):
    """Line numbers of subprocess.run(...) calls that pass no timeout=."""
    tree = ast.parse(open(path, encoding="utf-8").read())
    hits = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "run"):
            continue
        if not (isinstance(func.value, ast.Name) and func.value.id == "subprocess"):
            continue
        if any(k.arg == "timeout" for k in node.keywords):
            continue
        hits.append(node.lineno)
    return hits


# --- named timeout is distinguishable from a normal fail -----------------
signal.signal(signal.SIGALRM, _alarm)
signal.alarm(5)
t0 = time.monotonic()
raised = None
try:
    fr._run(["sleep", "30"], timeout=0.3)
except fr.FfmpegTimeout as e:
    raised = e
except Exception as e:  # noqa: BLE001
    raised = e
finally:
    signal.alarm(0)
elapsed = time.monotonic() - t0

check("timeout raises FfmpegTimeout (not CalledProcessError, not success)",
      isinstance(raised, fr.FfmpegTimeout))
check("error names ffmpeg timeout",
      raised is not None and "ffmpeg timeout" in str(raised))
check("call returns inside the bound", elapsed < 2.0)

nonzero = None
try:
    fr._run(["false"], timeout=2)
except subprocess.CalledProcessError as e:
    nonzero = e
except fr.FfmpegTimeout as e:
    nonzero = e
check("a normal non-zero exit is CalledProcessError, not FfmpegTimeout",
      isinstance(nonzero, subprocess.CalledProcessError))

ok = fr._run(["true"], timeout=2)
check("a fast command still succeeds", ok.returncode == 0)

# Process group: bash stays the session leader, sleep is the grandchild.
# killpg must reap both; a kill-the-parent-only helper leaves sleep behind.
marker = "38.917"
signal.alarm(5)
try:
    try:
        fr._run(["bash", "-c", f"sleep {marker}"], timeout=0.3)
    except fr.FfmpegTimeout:
        pass
    else:
        check("group-kill fixture must time out", False)
finally:
    signal.alarm(0)
time.sleep(0.2)
ps = subprocess.run(["ps", "-ax", "-o", "command="], capture_output=True, text=True)
leftover = [
    ln for ln in (ps.stdout or "").splitlines()
    if f"sleep {marker}" in ln and "bash -c" not in ln
]
check("process group reaped (no leftover sleep)", leftover == [])

# inspect_core re-exports the same named failure so /inspect cannot
# swallow a hang into empty frames.
check("inspect_core.FfmpegTimeout is the helper's class",
      ic.FfmpegTimeout is fr.FfmpegTimeout)

# --- no unbounded subprocess.run in the production files -----------------
here = os.path.dirname(os.path.abspath(__file__))
for name in ("app.py", "inspect_core.py", "ffmpeg_run.py"):
    hits = _unbounded_subprocess_runs(os.path.join(here, name))
    check(f"{name} has no unbounded subprocess.run", hits == [])

if check.failed:
    print(f"\n{check.failed} FAILED")
    sys.exit(1)
print("\nall ffmpeg-timeout checks passed")
