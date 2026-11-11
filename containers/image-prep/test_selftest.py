"""Route registration for POST /selftest (cf#1042). No rembg, no network.

The live cutout is the isolated Cloudflare Container. This file only proves the
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
check("_selftest_png is callable", callable(app._selftest_png))

png = app._selftest_png()
check("selftest PNG is a real file", png[:8] == b"\x89PNG\r\n\x1a\n")
check("selftest PNG is small", 100 < len(png) < 32 * 1024)

if check.failed:
    sys.exit(1)
print("all ok")
