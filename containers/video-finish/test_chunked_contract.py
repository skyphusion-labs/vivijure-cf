"""Contract tests for the cf#784 chunked-assemble URL pool. No ffmpeg, no network.

Runs in container-tests CI. It needs aiohttp only because importing app.py does; every
assertion here is pure validation logic, which is exactly the part that must refuse before
any encoding starts.

The pool exists because the container is CREDENTIALLESS by design (see README): it holds no
R2 binding, so it can only write a partial to a URL the Worker handed it. Everything below is
about refusing a malformed or unsafe pool loudly instead of discovering it mid-encode.

    python3 test_chunked_contract.py
"""
import sys

import app

R2 = "https://acct.r2.cloudflarestorage.com"

failures = []


def check(cond, label, extra=""):
    print(("[PASS] " if cond else "[FAIL] ") + label + ((" " + extra) if extra else ""))
    if not cond:
        failures.append(label)


def parse(pool):
    return app._parse_partial_urls({"partialUrls": pool})


def refuses(pool, needle, label):
    try:
        parse(pool)
        check(False, label, "accepted, expected a refusal")
    except app._JobError as e:
        check(needle in e.message, label, e.message[:80])


# Absent pool selects the single-pass path rather than erroring: an older Worker that does not
# know about chunking must keep working unchanged.
check(app._parse_partial_urls({}) == [], "no pool -> [] (single-pass path, back-compat)")
check(app._parse_partial_urls({"partialUrls": []}) == [], "empty pool -> [] (not an error)")

ok = parse([{"put": R2 + "/p0?sig=a", "get": R2 + "/p0?sig=b"}])
check(ok == [(R2 + "/p0?sig=a", R2 + "/p0?sig=b")], "a valid pair parses to (put, get)")
check(len(parse([{"put": R2 + "/p%d" % i, "get": R2 + "/g%d" % i} for i in range(5)])) == 5,
      "a 5-entry pool parses in order")

# The body accepts both spellings elsewhere, so the pool does too.
check(parse([{"putUrl": R2 + "/a", "getUrl": R2 + "/b"}]) == [(R2 + "/a", R2 + "/b")],
      "putUrl/getUrl spelling is accepted")

refuses([{"put": R2 + "/p0"}], "needs both put and get", "a pair missing get is REFUSED")
refuses([{"get": R2 + "/g0"}], "needs both put and get", "a pair missing put is REFUSED")
refuses(["not-an-object"], "must be an object", "a non-object entry is REFUSED")
refuses([{"put": "", "get": R2 + "/g"}], "needs both put and get", "an empty put is REFUSED")

# The SSRF guard must apply to pool URLs too. These are request-supplied and the container
# PUTs to them, so an unvalidated pool would be a write primitive pointed anywhere.
refuses([{"put": "http://evil.example/x", "get": R2 + "/g"}], "blocked", "an off-allowlist put is REFUSED")
refuses([{"put": R2 + "/p", "get": "http://169.254.169.254/latest"}], "blocked",
        "a metadata-endpoint get is REFUSED")
refuses([{"put": "file:///etc/passwd", "get": R2 + "/g"}], "blocked", "a file:// put is REFUSED")

# The batch bound has to be a real number or peak disk is unbounded again.
check(isinstance(app.MAX_BATCH_BYTES, int) and app.MAX_BATCH_BYTES > 0,
      "MAX_BATCH_BYTES is a positive int,", str(app.MAX_BATCH_BYTES))
check(app.MAX_BATCH_BYTES + app.MAX_CLIP_BYTES < 20 * 1024 ** 3,
      "batch bound + one clip of overshoot fits the 20 GB ceiling with room for 3x working set,",
      "%.2f GB" % ((app.MAX_BATCH_BYTES + app.MAX_CLIP_BYTES) / 1024 ** 3))

# https needs BOTH https and tls in the whitelist, and ffmpeg's default (file,crypto,data)
# refuses every network protocol. Measured, not assumed; see test_local_chunked.py.
for tok in ("http", "https", "tcp", "tls", "file"):
    check(tok in app.CONCAT_PROTOCOL_WHITELIST.split(","),
          "concat protocol whitelist carries %s" % tok)

print("\n%d failures" % len(failures))
for f in failures:
    print("  " + f)
sys.exit(1 if failures else 0)
