"""The upload path must never materialise a produced artifact in memory (cf#802).

Runs in container-tests CI. No ffmpeg, no network, no big files -- deliberately. A test that
"a large file uploads" would need an artifact big enough to OOM the runner to fail, which makes it
slow, flaky, and impossible to run in CI. The invariant is not about size, it is about SHAPE: the
bytes must reach the socket from a file handle, never from a `bytes` object.

WHY THIS CONTROL EXISTS. Three routes here produce a full film and all four PUT sites read the
whole artifact with `f.read()` before uploading it. A Cloudflare Container has no swap, so
exceeding memory restarts the instance; disk is ephemeral and resets to the image on wake, so the
work dir dies with it and the next poll finds no job. The film does not fail loudly, it fails as
though it never ran. Nothing in the suite could observe that, and the peak-RSS measurement that
sized the instance excluded it, because the measurement stopped at the concat.

TWO LAYERS, because either alone is escapable:
  1. BEHAVIOURAL -- drive the real _put_file and inspect what actually reaches session.put.
  2. STRUCTURAL -- scan app.py for the read-then-upload shape, so the pattern cannot be
     reintroduced by copying a neighbouring route, which is exactly how it spread to four sites.

    python3 test_upload_streams.py
"""
import asyncio
import os
import re
import sys
import tempfile

import app

R2 = "https://acct.r2.cloudflarestorage.com/out.mp4?sig=x"
failures = []


def check(cond, label, extra=""):
    print(("[PASS] " if cond else "[FAIL] ") + label + ((" " + extra) if extra else ""))
    if not cond:
        failures.append(label)


class _Resp:
    def __init__(self, status): self.status = status
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False


class _Session:
    """Captures exactly what the production code hands to aiohttp."""
    def __init__(self, status=200):
        self.status, self.calls = status, []
    def put(self, url, **kw):
        self.calls.append((url, kw))
        return _Resp(self.status)


# ---------------------------------------------------------------- 1. BEHAVIOURAL
payload = b"\x00\x01\x02" * 5000
fd, path = tempfile.mkstemp(suffix=".mp4")
with os.fdopen(fd, "wb") as f:
    f.write(payload)

sess = _Session()
size = asyncio.run(app._put_file(sess, R2, path))

check(len(sess.calls) == 1, "one PUT issued")
_url, kw = sess.calls[0]
data = kw.get("data")

# THE assertion. If this ever reads `bytes`, the artifact is in RAM and the OOM is back.
check(not isinstance(data, (bytes, bytearray, memoryview, str)),
      "upload body is NOT a materialised buffer,", "got %s" % type(data).__name__)
check(hasattr(data, "read"), "upload body is a streamable file object")
check(size == len(payload), "returns the real byte count,", "%d" % size)

hdrs = {k.lower(): v for k, v in (kw.get("headers") or {}).items()}
# A presigned PUT will not accept chunked transfer-encoding, which is what aiohttp falls back to
# for a file object with no length. Streaming without this header trades an OOM for a 4xx.
check(hdrs.get("content-length") == str(len(payload)),
      "Content-Length is set explicitly,", str(hdrs.get("content-length")))
check(hdrs.get("content-type") == "video/mp4", "default content-type is video/mp4")

sess2 = _Session()
asyncio.run(app._put_file(sess2, R2, path, content_type="image/jpeg"))
check({k.lower(): v for k, v in sess2.calls[0][1]["headers"].items()}.get("content-type") == "image/jpeg",
      "content-type override is honoured (/frames sends a sheet, not a film)")

# A refused upload must still raise rather than be reported as a success.
try:
    asyncio.run(app._put_file(_Session(status=500), R2, path))
    check(False, "a non-2xx PUT raises")
except app._JobError as e:
    check(e.status == 502, "a non-2xx PUT raises _JobError(502),", e.message)
os.remove(path)

# ---------------------------------------------------------------- 2. STRUCTURAL
src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.py")
src = open(src_path, encoding="utf-8").read()

# The exact shape that caused this: a whole-file read bound to a name, then handed to a PUT.
reads = [i for i, l in enumerate(src.split("\n"), 1) if re.search(r"=\s*f\.read\(\)\s*$", l)]
check(not reads, "no whole-file read feeds an upload,", "offending lines: %r" % reads)

# Every inline `data=` handed to guarded_put, minus the forms that are BOUNDED BY CONSTRUCTION.
# An artifact upload must go through _put_file; anything else has to earn its exemption here,
# in writing, which is the point -- a new unbounded upload cannot slip in unnoticed.
EXEMPT = (
    "data=f,",                  # _put_file itself: the streaming helper every artifact uses
    "data=_json.dumps(",        # meta sidecar: a two-field JSON blob
    "data=srt_text.encode(",    # SRT sidecar: subtitle text, capped at MAX_SRT_BYTES (512 KB)
)


def inline_puts(text):
    return [i for i, l in enumerate(text.split("\n"), 1)
            if "guarded_put(" in l and "data=" in l
            and not any(e in l.replace(" ", "") or e in l for e in EXEMPT)]


check(inline_puts(src) == [],
      "every artifact upload goes through _put_file,", "unexempted inline puts at %r" % inline_puts(src))

# Positive control: the structural scan must be able to FAIL. If it cannot see a planted
# violation, it is decoration and the two checks above prove nothing.
planted = src + (
    '\n\nasync def _planted(s, u, p):\n'
    '    with open(p, "rb") as f:\n'
    '        out_bytes = f.read()\n'
    '    async with guarded_put(s, u, data=out_bytes) as r:\n'
    '        return r\n'
)
planted_reads = [i for i, l in enumerate(planted.split("\n"), 1) if re.search(r"=\s*f\.read\(\)\s*$", l)]
check(len(planted_reads) == 1 and len(inline_puts(planted)) == 1,
      "the structural scan DOES catch a planted violation,",
      "read@%r put@%r" % (planted_reads, inline_puts(planted)))

print("\n%d failures" % len(failures))
for f in failures:
    print("  " + f)
sys.exit(1 if failures else 0)
