"""cf#571: a hung ffmpeg/ffprobe cannot hold an audio-mix worker thread forever.

Same fixture as containers/video-finish/test_ffmpeg_timeout.py: a real sleep
child, a named FfmpegTimeout, distinguishable from CalledProcessError.

Run:  python3 test_ffmpeg_timeout.py
Exits non-zero on any failed assertion. Stdlib only; no ffmpeg needed.
"""
import ast
import os
import signal
import subprocess
import sys
import time

import mix_core as mc


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


signal.signal(signal.SIGALRM, _alarm)
signal.alarm(5)
t0 = time.monotonic()
raised = None
try:
    mc._run(["sleep", "30"], timeout=0.3)
except mc.FfmpegTimeout as e:
    raised = e
except Exception as e:  # noqa: BLE001
    raised = e
finally:
    signal.alarm(0)
elapsed = time.monotonic() - t0

check("timeout raises FfmpegTimeout", isinstance(raised, mc.FfmpegTimeout))
check("error names ffmpeg timeout",
      raised is not None and "ffmpeg timeout" in str(raised))
check("call returns inside the bound", elapsed < 2.0)

nonzero = None
try:
    mc._run(["false"], timeout=2)
except subprocess.CalledProcessError as e:
    nonzero = e
except mc.FfmpegTimeout as e:
    nonzero = e
check("nonzero is CalledProcessError, not FfmpegTimeout",
      isinstance(nonzero, subprocess.CalledProcessError))

here = os.path.dirname(os.path.abspath(__file__))
hits = _unbounded_subprocess_runs(os.path.join(here, "mix_core.py"))
check("mix_core.py has no unbounded subprocess.run", hits == [])

if check.failed:
    print(f"\n{check.failed} FAILED")
    sys.exit(1)
print("\nall audio-mix ffmpeg-timeout checks passed")
