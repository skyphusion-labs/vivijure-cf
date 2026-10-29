"""Route registration for POST /selftest (cf#1040). No ffmpeg, no network.

The live burn is the isolated Cloudflare Container. This file only proves the
route exists so a missing add_post cannot ship.
"""
import sys

import app


def check(name, cond):
    if cond:
        print(f"  ok  {name}")
    else:
        print(f"FAIL  {name}")
        check.failed += 1


check.failed = 0

posts = []
for route in app.app.router.routes():
    if getattr(route, "method", None) == "POST":
        posts.append(route.resource.canonical)

check("POST /selftest is registered", "/selftest" in posts)
check("_selftest is callable", callable(app._selftest))
check("selftest is not an async job route", "selftest" not in app.ASYNC_WORKS)

if check.failed:
    sys.exit(1)
print("all ok")
