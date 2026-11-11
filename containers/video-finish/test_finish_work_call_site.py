"""cf#851: the CALL SITE of _parse_partial_urls, not the helper. No ffmpeg, no network.

WHY THIS FILE EXISTS. `_parse_partial_urls` was well tested (3 references in
test_chunked_contract.py, 2 in test_local_chunked.py) and correct all along, while the single
line that INVOKES it passed an undefined name:

    async def _finish_work(body):
        ...
        partial_urls = _parse_partial_urls(raw)   # `raw` is not bound in this scope

Every assemble raised `NameError: name 'raw' is not defined` from 2026-09-27T01:52:20Z
(0cdd5fca6, #801) until it was fixed, and no test caught it because **nothing in the suite called
`_finish_work` at all** -- zero references across every test_*.py in this directory. The helper on
one side and `_finish_chunked` on the other were both covered; the line joining them was not.

So this file's job is narrow and deliberate: ENTER `_finish_work` and reach that line. It is not a
test of the chunked path, which test_chunked_contract.py already owns, and it is not a test of the
single-pass path.

THE SEAM. `_finish_chunked` is stubbed so nothing downloads or encodes, and that stub is the ONLY
thing replaced. `_parse_partial_urls` runs for real, all the validation above the call site runs
for real, and `body` is a real request dict. Stubbing the helper instead would have re-tested the
half that was already working.

WHY THERE IS NO NO-POOL CASE HERE, stated because its absence is deliberate. Without a pool the
function falls through to the single-pass path and starts downloading clips. A first draft of this
file included that case and it made a REAL NETWORK CALL, failing with an SSL handshake error
against r2.cloudflarestorage.com -- while the assertion still reported PASS, because the assertion
was "did not raise NameError" and any other exception satisfies it. That check would have gone on
passing with the call site arbitrarily broken, and the docstring above it would have gone on
claiming "no network". Covering the no-pool branch honestly needs the download path stubbed too,
which would make this a test of the single-pass path rather than of the call site. It is left to
whoever takes that on.

    python3 test_finish_work_call_site.py
"""
import asyncio
import sys

import app

R2 = "https://acct.r2.cloudflarestorage.com"

failures = []


def check(cond, label, extra=""):
    print(("[PASS] " if cond else "[FAIL] ") + label + ((" " + extra) if extra else ""))
    if not cond:
        failures.append(label)


def body_with_pool():
    """A minimally valid /finish body carrying a partial-URL pool, so _finish_work reaches the
    call site and then takes the chunked branch straight into the stub. Nothing here is fetched."""
    return {
        "clips": [{"url": R2 + "/a.mp4"}, {"url": R2 + "/b.mp4"}],
        "outputUrl": R2 + "/film.mp4",
        "outputKey": "film.mp4",
        "partialUrls": [{"put": R2 + "/p0.put", "get": R2 + "/p0.get"}],
    }


SENTINEL = {"ok": True, "_stub": "chunked"}


def run_with_stubbed_chunked(body):
    """Call the real _finish_work with only _finish_chunked replaced."""
    original = app._finish_chunked
    seen = {}

    async def fake_chunked(b, partial_urls, t0):
        seen["body"] = b
        seen["partial_urls"] = partial_urls
        return SENTINEL

    app._finish_chunked = fake_chunked
    try:
        return asyncio.run(app._finish_work(body)), None, seen
    except Exception as exc:  # NameError included, deliberately broad
        return None, exc, seen
    finally:
        app._finish_chunked = original


# --- the regression itself -------------------------------------------------------------------
result, err, seen = run_with_stubbed_chunked(body_with_pool())

check(not isinstance(err, NameError),
      "_finish_work reaches the _parse_partial_urls call site without a NameError",
      ("raised %r" % (err,)) if err else "")
check(err is None, "_finish_work with a valid pooled body raises nothing",
      ("raised %r" % (err,)) if err else "")
check(result is SENTINEL, "_finish_work took the chunked branch and returned its result")
check(seen.get("partial_urls") and len(seen["partial_urls"]) == 1,
      "the pool parsed at the call site was handed to _finish_chunked",
      "got %r" % (seen.get("partial_urls"),))
check(seen.get("body") is not None and seen["body"].get("outputKey") == "film.mp4",
      "the body reached _finish_chunked intact")

# --- CONTROL: this harness can actually observe a NameError at that call site -----------------
# Without this, every check above could pass vacuously if the harness swallowed the failure or
# never entered the function at all. Rebind the module global the fixed line reads, so the REAL
# line raises for a reason the harness did not manufacture inside its own try block.
_real_parse = app._parse_partial_urls


def _boom(_):
    raise NameError("name 'raw' is not defined")


app._parse_partial_urls = _boom
try:
    _, control_err, control_seen = run_with_stubbed_chunked(body_with_pool())
finally:
    app._parse_partial_urls = _real_parse

check(isinstance(control_err, NameError),
      "CONTROL: a NameError at the call site IS caught and reported by this harness",
      "got %r" % (control_err,))
check("body" not in control_seen,
      "CONTROL: that failure stopped the run before _finish_chunked, so the checks above "
      "cannot pass on a run that never reached the call site")

print("\n%d failures" % len(failures))
for f in failures:
    print("  " + f)
sys.exit(1 if failures else 0)
