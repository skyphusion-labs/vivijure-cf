"""Regression test for the measurement sidecar write (vivijure-core#130, #663; vivijure-cf#373).

_put_meta_sidecar is BEST-EFFORT BY CONTRACT: it never raises, so a caller-visible 200/ok:true on
/film-titles or /subtitle proves NOTHING about whether the sidecar was actually written. The
defect this guards (vivijure-cf#373) was exactly that: `json` is imported only as `_json` in this
module, so `json.dumps(payload)` inside _put_meta_sidecar raised a NameError on every call, was
swallowed by the function's own `except Exception`, logged as a warning, and returned --
silently. Every route that calls it (/film-titles, /subtitle) kept returning 200, and no sidecar
ever existed. A test asserting only the route's status code is satisfied by the BROKEN version;
this test asserts the sidecar BODY was actually PUT and parses to the expected shape.

Units are SECONDS here, matching the module contract (vivijure-core FilmFinishOutput). The reading
half (vivijure-core#131) multiplies by 1000 to get output_ms -- a units mismatch between the two
halves is the next silent failure waiting to happen, so this file states the unit explicitly
rather than leaving it implicit in a bare float.

CONTROL, run and recorded before this file shipped: with `data=json.dumps(...)` (the unfixed
line), _put_meta_sidecar's own `except Exception` swallows the NameError, so no PUT is ever
attempted -- "a PUT was actually attempted" fails, every check below it is skipped, and the run
exits non-zero. That is the proof this test can distinguish the two states rather than passing
regardless of which one is shipped; it does not merely assert the route's HTTP status, which the
broken version already satisfies.

guarded_put and validate_fetch_url are monkeypatched for the duration of each case (module-global
lookup, same mechanism test_url_guard.py's own regression check relies on): this isolates the
_put_meta_sidecar logic under test from real networking and from the SSRF allowlist, neither of
which is what vivijure-cf#373 is about. guarded_put's replacement keeps its real contract intact
-- a SYNC factory returning an async context manager, never `async def` -- per test_url_guard.py's
own regression check for that exact shape.

Run (inside the image):  python3 test_meta_sidecar.py
Exits non-zero on any failed assertion.
"""
import asyncio
import json
import sys

import app


def check(name, cond):
    if cond:
        print(f"  ok  {name}")
    else:
        print(f"FAIL  {name}")
        check.failed += 1
check.failed = 0


class _FakeResponse:
    def __init__(self, status=200):
        self.status = status


class _FakePutCM:
    """Sync factory returning an async context manager -- matches guarded_put's real contract."""

    def __init__(self, captured, url, kwargs):
        captured["url"] = url
        captured["data"] = kwargs.get("data")
        captured["headers"] = kwargs.get("headers")
        captured["calls"] = captured.get("calls", 0) + 1

    async def __aenter__(self):
        return _FakeResponse(200)

    async def __aexit__(self, exc_type, exc, tb):
        return False


def _fake_guarded_put(captured):
    def factory(session, url, **kwargs):
        return _FakePutCM(captured, url, kwargs)
    return factory


async def _run_case(meta_url, *, duration_seconds=None, prepend_seconds=None):
    """Call the real _put_meta_sidecar with guarded_put/validate_fetch_url swapped out, and
    return what was captured. Restores both, even on an unexpected raise from the code under
    test -- this test must never itself hide a NameError the way the bug does."""
    captured = {}
    real_guarded_put = app.guarded_put
    real_validate = app.validate_fetch_url
    app.guarded_put = _fake_guarded_put(captured)
    app.validate_fetch_url = lambda url: (True, None)
    try:
        await app._put_meta_sidecar(
            meta_url, duration_seconds=duration_seconds, prepend_seconds=prepend_seconds,
        )
    finally:
        app.guarded_put = real_guarded_put
        app.validate_fetch_url = real_validate
    return captured


async def _case(name, *, duration_seconds=None, prepend_seconds=None, expected):
    captured = await _run_case(
        "https://example.invalid/meta.json",
        duration_seconds=duration_seconds, prepend_seconds=prepend_seconds,
    )

    check(f"{name}: a PUT was actually attempted", captured.get("calls") == 1)
    if captured.get("calls") != 1:
        return  # everything below assumes a captured call; nothing left to check

    body_bytes = captured["data"]
    check(f"{name}: PUT body is bytes (the json.dumps-on-an-undefined-name symptom is a swallowed "
          f"NameError before this line is ever reached, not a bad body)",
          isinstance(body_bytes, (bytes, bytearray)))

    try:
        parsed = json.loads(body_bytes)
    except Exception as e:  # noqa: BLE001
        check(f"{name}: PUT body parses as JSON", False)
        print(f"       -- {e!r}")
        return
    check(f"{name}: PUT body parses as JSON", True)
    check(f"{name}: PUT body == {expected!r}", parsed == expected)
    check(f"{name}: content-type header is application/json",
          captured["headers"].get("content-type") == "application/json")


async def main():
    # /film-titles shape: duration_seconds AND prepend_seconds, per strummer's retained evidence.
    await _case(
        "film-titles shape (duration + prepend)",
        duration_seconds=3.5, prepend_seconds=1.5,
        expected={"duration_seconds": 3.5, "prepend_seconds": 1.5},
    )

    # /subtitle shape: duration only. The subtitle module never prepends (it burns in place), so
    # prepend_seconds is never passed at that call site -- the key must be ABSENT, not present-and-
    # zero (0 is a real value the core's fold-path gate would treat as unmeasured; see core#132).
    await _case(
        "subtitle shape (duration only, no prepend key at all)",
        duration_seconds=3.5, prepend_seconds=None,
        expected={"duration_seconds": 3.5},
    )

    # Boundary right next to this bug, not the bug itself: nothing measurable means no PUT at all
    # (an empty sidecar and an absent one both mean NOT MEASURED, per the function's own docstring).
    captured = await _run_case("https://example.invalid/meta.json")
    check("nothing measurable: no PUT attempted", captured.get("calls") is None)

    # A 0 or negative measurement is not a measurement (core's own fold-path gate, core#132):
    # confirm the container side agrees and drops it rather than shipping a fake zero.
    captured = await _run_case(
        "https://example.invalid/meta.json", duration_seconds=0, prepend_seconds=-1,
    )
    check("zero/negative measurements are dropped, not PUT as zero", captured.get("calls") is None)


asyncio.run(main())
if check.failed:
    print(f"\n{check.failed} FAILED")
    sys.exit(1)
print("\nall meta-sidecar tests passed")
