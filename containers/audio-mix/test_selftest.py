"""Route registration for POST /selftest (cf#1044). No ffmpeg, no network.

Reads app.py as text so CI does not import aiohttp or run a mix.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "app.py"), encoding="utf-8").read()


def check(name, cond):
    if cond:
        print(f"  ok  {name}")
    else:
        print(f"FAIL  {name}")
        check.failed += 1


check.failed = 0
check("POST /selftest is registered", 'add_post("/selftest", selftest)' in src)
check("_selftest is defined", "def _selftest(" in src)
if check.failed:
    sys.exit(1)
print("all ok")
