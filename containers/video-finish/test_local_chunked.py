"""Real-ffmpeg, real-HTTP proof of chunked assemble (cf#784).

    python3 test_local_chunked.py

Needs ffmpeg/ffprobe on PATH and aiohttp; stands up its own range-capable, PUT-accepting origin
on loopback. NOT run in container-tests CI, for the same runner reason ci.yml gives for
test_local.py -- ffmpeg presence there is not established by effect. This file exists to be run
and read as evidence, like its siblings.

WHAT IT IS FOR. Chunked assemble introduces a SECOND concat level, so it doubles the places a
clip can vanish, and a dropped PARTIAL is a film short by a whole batch rather than one shot.
The ratio guard this replaced could not see that past 7 parts. ARM 2 drops a real partial from
a real 9-batch join and requires the outer guard to catch it, and asserts in the same breath
that the old 0.85 ratio would NOT have -- so it demonstrates the fix, not merely a passing test.

THE ONE STUB, stated plainly: url_guard's allowlist is bypassed, because it requires https and
rejects IP literals, and standing up trusted TLS on loopback would exercise the certificate store
rather than the chunking. The SSRF guard has its own suite (test_url_guard.py) which DOES run in
CI, and the pool's own validation is covered without ffmpeg in test_chunked_contract.py. Nothing
else is stubbed: real clips, real ffmpeg normalize and concat, real range GETs, real PUTs.
"""
import asyncio, os, shutil, subprocess, sys, tempfile, threading
import http.server, socketserver, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = tempfile.mkdtemp(prefix="e2e-chunk-")
SRV = os.path.join(ROOT, "srv"); os.makedirs(SRV)
PORT = 8741

# Every filename this throwaway origin will ever serve or accept, fixed up front. Membership in
# a constant set is what keeps the handler free of a path built from request input.
ALLOWED_NAMES = frozenset(
    ["out.mp4"]
    + ["clip_%02d.mp4" % i for i in range(100)]
    + ["partial_%02d.mp4" % k for k in range(100)]
)


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def _path(self):
        """Resolve a request to a served file, or None.

        The name is matched against a CONSTANT allowlist rather than sanitized out of the
        request, so the joined path never derives from input at all. os.path.basename alone
        would mostly work and is exactly the kind of "probably fine" sanitizer that makes a
        path-injection finding arguable; a fixed set is not arguable. (CodeQL py/path-injection
        flagged the earlier basename form on #801, correctly.)
        """
        name = self.path.split("?")[0].lstrip("/")
        if name not in ALLOWED_NAMES:
            return None
        return os.path.join(SRV, name)
    def do_PUT(self):
        p = self._path()
        if p is None:
            self.send_response(403); self.send_header("Content-Length", "0"); self.end_headers(); return
        n = int(self.headers.get("Content-Length", "0"))
        left, out = n, open(p, "wb")
        while left > 0:
            b = self.rfile.read(min(65536, left))
            if not b: break
            out.write(b); left -= len(b)
        out.close()
        self.send_response(200); self.send_header("Content-Length", "0"); self.end_headers()
    def do_GET(self):
        p = self._path()
        if p is None or not os.path.isfile(p):
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
        size = os.path.getsize(p); start, end, st = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m and m.group(1):
                start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1; st = 206
        end = min(end, size - 1); n = max(0, end - start + 1)
        self.send_response(st)
        self.send_header("Content-Type", "video/mp4"); self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(n))
        if st == 206: self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        with open(p, "rb") as f:
            f.seek(start); left = n
            while left > 0:
                b = f.read(min(65536, left))
                if not b: break
                self.wfile.write(b); left -= len(b)

class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True; daemon_threads = True

srv = S(("127.0.0.1", PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

import url_guard
url_guard._safe_fetch_url = lambda u: u
import app
app.validate_fetch_url = lambda u: (True, None)

BASE = "http://127.0.0.1:%d" % PORT

def mkclip(i, dur):
    p = os.path.join(SRV, "clip_%02d.mp4" % i)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", "testsrc=size=320x240:rate=24:duration=%.3f" % dur,
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
                    "-pix_fmt", "yuv420p", p], check=True)
    return {"url": "%s/clip_%02d.mp4" % (BASE, i)}

def pool(n):
    # Go through the real parser, so the test exercises _parse_partial_urls rather than
    # hand-building the tuple shape _finish_chunked consumes.
    return app._parse_partial_urls({"partialUrls": [
        {"put": "%s/partial_%02d.mp4" % (BASE, k), "get": "%s/partial_%02d.mp4" % (BASE, k)}
        for k in range(n)]})

def body(clips, **over):
    b = {"clips": clips, "outputUrl": "%s/out.mp4" % BASE, "outputKey": "out.mp4",
         "width": 320, "height": 240, "fps": 24, "crf": 30, "preset": "veryfast",
         "crossfade": 0.0, "trimJoinFrames": 0}
    b.update(over); return b

def probe(p):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                 "-of", "csv=p=0", p], capture_output=True, text=True).stdout.strip())

fails = []
def check(c, label, extra=""):
    print(("[PASS] " if c else "[FAIL] ") + label + (" " + extra if extra else ""))
    if not c: fails.append(label)

N = 9
clips = [mkclip(i, 1.0) for i in range(N)]

# --- ARM 1: force MULTI-BATCH by shrinking the byte bound below one clip -------
app.MAX_BATCH_BYTES = 1
r = asyncio.run(app._finish_chunked(body(clips), pool(N), 0.0))
check(r["ok"] is True, "multi-batch assemble returned ok")
check(r["batches"] == N, "one batch per clip at a 1-byte bound,", "batches=%d" % r["batches"])
check(len(r["clipDurations"]) == N, "clipDurations carries every clip in order,", str(r["clipDurations"][:3]) + "...")
out_dur = probe(os.path.join(SRV, "out.mp4"))
check(abs(out_dur - N * 1.0) < 0.1, "film duration is the sum of its clips,", "%.3fs vs %d.0s" % (out_dur, N))
check(abs(r["durationSeconds"] - out_dur) < 0.01, "reported duration matches the artifact,", "%.3f" % r["durationSeconds"])

# --- ARM 2: the OUTER guard must catch a DROPPED PARTIAL -----------------------
# Inject at the seam chunking creates: the partial list handed to the final join loses one.
real_join = app._concat_hard_urls
def dropping(urls, out, list_path): return real_join(urls[:-1], out, list_path)
app._concat_hard_urls = dropping
try:
    asyncio.run(app._finish_chunked(body(clips), pool(N), 0.0))
    check(False, "dropped PARTIAL caught at the outer join")
except Exception as e:
    from concat_guard import ConcatDropError
    inner = e.message if hasattr(e, "message") else str(e)
    check("dropped footage at final join" in inner or isinstance(e, ConcatDropError),
          "dropped PARTIAL caught at the outer join,", inner[:110])
    ratio = (N - 1) / N
    check(not (ratio < 0.85), "and the OLD 0.85 ratio was BLIND here,", "%d partials, ratio %.4f" % (N, ratio))
finally:
    app._concat_hard_urls = real_join

# --- ARM 3: single batch must skip the pool entirely (no R2 round trip) --------
app.MAX_BATCH_BYTES = 1024 * 1024 * 1024
for k in range(N):
    fp = os.path.join(SRV, "partial_%02d.mp4" % k)
    if os.path.exists(fp): os.remove(fp)
r = asyncio.run(app._finish_chunked(body(clips), pool(N), 0.0))
check(r["batches"] == 1, "whole film in one batch at a 1 GB bound,", "batches=%d" % r["batches"])
uploaded = [f for f in os.listdir(SRV) if f.startswith("partial_")]
check(uploaded == [], "single-batch film uploaded NO partials,", "found %r" % uploaded)
check(abs(probe(os.path.join(SRV, "out.mp4")) - N * 1.0) < 0.1, "single-batch film is still correct")

# --- ARM 4: crossfade across a batch boundary must REFUSE, not silently drop ---
app.MAX_BATCH_BYTES = 1
try:
    asyncio.run(app._finish_chunked(body(clips, crossfade=0.5), pool(N), 0.0))
    check(False, "crossfade + multi-batch refused")
except Exception as e:
    msg = getattr(e, "message", str(e))
    check("crossfade is not supported with chunked assemble" in msg,
          "crossfade + multi-batch REFUSED loudly,", msg[:90])

# --- ARM 5: an exhausted pool must refuse rather than silently truncate --------
try:
    asyncio.run(app._finish_chunked(body(clips), pool(2), 0.0))
    check(False, "short pool refused")
except Exception as e:
    msg = getattr(e, "message", str(e))
    check("pool exhausted" in msg, "short URL pool REFUSED loudly,", msg[:90])

srv.shutdown()
shutil.rmtree(ROOT, ignore_errors=True)
print("\n%d failures" % len(fails))
for f in fails: print("  " + f)
sys.exit(1 if fails else 0)
