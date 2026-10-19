"""The upload path must never materialise the mixed film audio in memory (cf#814, the cf#802 shape).

Runs in container-tests CI. No ffmpeg, no network, no big files -- deliberately. A test that
"a large file uploads" would need an artifact big enough to OOM the runner to fail, which makes it
slow, flaky, and impossible to run in CI. The invariant is not about size, it is about SHAPE: the
bytes must reach the socket from a file handle, never from a `bytes` object.

WHY THIS CONTROL EXISTS. `/mix` USED to read the whole produced artifact into a `bytes` before
uploading it. `format` defaults to `mp3` but ACCEPTS `wav`, and a film-length stereo WAV runs
about 10 MB per minute, on top of up to MAX_TRACKS x MAX_TRACK_BYTES of downloaded sources still
on disk. A Cloudflare Container has no swap, so exceeding memory restarts the instance; disk is
ephemeral and resets to the image on wake, so the work dir dies with it and the next poll finds no
job. The film does not fail loudly, it fails as though it never ran.

The shape reached four sites in video-finish by being copied from a neighbouring route, and it
reached the audio pair the same way -- audio-master's module docstring says it is "Modeled on
containers/audio-mix/app.py", and this file's says it is modeled on video-finish. That is
precisely why the structural half below exists: a fix without it is one copy-paste from being
undone.

TWO LAYERS, because either alone is escapable:
  1. BEHAVIOURAL -- drive the real _put_file and inspect what actually reaches session.put.
  2. STRUCTURAL -- scan app.py for the read-then-upload shape, so the pattern cannot be
     reintroduced by copying a neighbouring route.

    python3 test_upload_streams.py
"""
import ast
import asyncio
import os
import sys
import tempfile

import app

R2 = "https://acct.r2.cloudflarestorage.com/out.mp3?sig=x"
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
fd, path = tempfile.mkstemp(suffix=".mp3")
with os.fdopen(fd, "wb") as f:
    f.write(payload)

sess = _Session()
size = asyncio.run(app._put_file(sess, R2, path, "audio/mpeg"))

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
check(hdrs.get("content-type") == "audio/mpeg", "the mp3 content-type reaches the wire")

# /mix serves both formats off one helper; the wav path is the one that gets large.
sess2 = _Session()
asyncio.run(app._put_file(sess2, R2, path, "audio/wav"))
check({k.lower(): v for k, v in sess2.calls[0][1]["headers"].items()}.get("content-type") == "audio/wav",
      "content-type is per-call, so format=wav is labelled audio/wav")

# A refused upload must still raise rather than be reported as a success, and the route's wire
# error string must be unchanged by the switch to streaming.
try:
    asyncio.run(app._put_file(_Session(status=500), R2, path, "audio/mpeg"))
    check(False, "a non-2xx PUT raises")
except app._PutFailed as e:
    check(e.status == 500 and str(e) == "output put 500",
          "a non-2xx PUT raises _PutFailed carrying the upstream status,", str(e))
os.remove(path)

# ---------------------------------------------------------------- 2. STRUCTURAL
#
# PARSED, not grepped. A line-regex version of this scan was MEASURED blind to two one-line
# evasions: a read handle named anything other than `f`, and a `guarded_put(` whose `data=` sat on
# a continuation line. Both are ordinary hand-written formatting, so a scan that misses them does
# not cover the case it exists for. `ast` sees the call, not the layout.
src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.py")
src = open(src_path, encoding="utf-8").read()

# Functions allowed to hold a whole-file read. Empty on purpose: no route needs one. An entry
# here is a written, reviewable exemption, which is the only way one should ever appear.
READ_EXEMPT_FUNCS = ()

# `data=` expressions that are BOUNDED BY CONSTRUCTION, matched on the unparsed expression.
# Empty on purpose: this container uploads exactly one artifact and it is the produced mix, so
# there is no small-sidecar case. Anything else must go through _put_file.
EXEMPT_DATA = ()


def _owners(tree):
    """Map every node to the name of the function that lexically contains it."""
    owner = {}
    for fn in ast.walk(tree):
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for child in ast.walk(fn):
                owner.setdefault(child, fn.name)
    return owner


def whole_file_reads(text):
    """Every zero-argument `<anything>.read()`: the shape that materialises an artifact in RAM.

    `.read(n)` is bounded and fine. The receiver's NAME is irrelevant, which is the whole point:
    this sees `fh.read()` exactly as it sees `f.read()`. Prose in a docstring is not a call, so
    the helper's own "Deliberately NOT `data=f.read()`" comment cannot trip it either.
    """
    tree = ast.parse(text)
    owner = _owners(tree)
    return sorted(n.lineno for n in ast.walk(tree)
                  if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                  and n.func.attr == "read" and not n.args and not n.keywords
                  and owner.get(n) not in READ_EXEMPT_FUNCS)


def inline_puts(text):
    """Every `guarded_put(data=...)` that is neither _put_file itself nor a written exemption."""
    tree = ast.parse(text)
    owner = _owners(tree)
    out = []
    for n in ast.walk(tree):
        if not (isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                and n.func.id == "guarded_put"):
            continue
        data = next((kw.value for kw in n.keywords if kw.arg == "data"), None)
        if data is None:
            continue
        if owner.get(n) == "_put_file":
            continue  # the streaming helper every artifact upload is required to use
        if any(ast.unparse(data).startswith(e) for e in EXEMPT_DATA):
            continue
        out.append(n.lineno)
    return sorted(out)


base_reads, base_puts = whole_file_reads(src), inline_puts(src)
check(not base_reads, "no whole-file read anywhere in app.py,", "offending lines: %r" % base_reads)
check(not base_puts, "every artifact upload goes through _put_file,", "unexempted puts at %r" % base_puts)

# POSITIVE CONTROL. The scan must be able to FAIL, or the two checks above prove nothing. Both
# shapes are planted: the one that actually shipped here, and the evasion that defeated the regex
# version. Asserted as a DELTA against the real file, so a genuine violation in app.py makes the
# checks above go red without also corrupting the control into a confusing second failure.
PLANTS = {
    "the shape that actually shipped": (
        '\n\nasync def _planted_a(s, u, p):\n'
        '    with open(p, "rb") as f:\n'
        '        out_bytes = f.read()\n'
        '    async with guarded_put(s, u, data=out_bytes) as r:\n'
        '        return r\n'
    ),
    "a renamed handle with the call wrapped over lines": (
        '\n\nasync def _planted_b(s, u, p):\n'
        '    with open(p, "rb") as fh:\n'
        '        out_bytes = fh.read()\n'
        '    async with guarded_put(\n'
        '        s, u,\n'
        '        data=out_bytes,\n'
        '    ) as r:\n'
        '        return r\n'
    ),
}
for _label, _body in PLANTS.items():
    _planted = src + _body
    _dr = len(whole_file_reads(_planted)) - len(base_reads)
    _dp = len(inline_puts(_planted)) - len(base_puts)
    check(_dr == 1 and _dp == 1,
          "the scan catches %s," % _label,
          "read delta %d, put delta %d" % (_dr, _dp))

print("\n%d failures" % len(failures))
for f in failures:
    print("  " + f)
sys.exit(1 if failures else 0)
