"""Real-ffmpeg, real-HTTP proof of POST /async/join-films.

    python3 test_local_join_films.py

Needs ffmpeg/ffprobe on PATH and aiohttp. Stands up a range-capable, PUT-accepting origin on loopback. NOT run in
container-tests CI, for the same runner reason ci.yml gives for test_local.py.

THE ONE STUB: url_guard's allowlist, because it requires https and refuses IP literals. test_join_films.py and
test_url_guard.py cover it in CI. Nothing else is stubbed: real films, real ffprobe and ffmpeg over HTTP, real PUTs.

THE AUDIO MEASUREMENT. Each film has a white flash and a tone, both at 1 s, and its audio is 21 to 34 ms longer
than its video, which is the shape a real film has. In the join, each film's offset is tone time less flash time.
The flash time is a decoded frame's timestamp. The tone time is its SAMPLE COUNT from the start of the audio, with
no filter, which is what a player that plays samples in order hears.

DO NOT MEASURE THIS WITH silencedetect OR ANY OTHER TIMESTAMP READING. A plain stream copy joins with overlapping
audio packets: their timestamps stay right and the join carries more samples than they imply. silencedetect reads
0 ms on that file. Counted in samples, the same file runs late at every join. The plain copy is the control here.
It must measure worse, or this test cannot tell the two apart.
"""
import array
import asyncio
import hashlib
import http.server
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("LOCAL_FINISH_TOKEN", "test-token")

ROOT = tempfile.mkdtemp(prefix="e2e-join-")
SRV = os.path.join(ROOT, "srv")
os.makedirs(SRV)
PORT = 8743
FILMS = 8
SPREAD_LIMIT_S = 0.010
ALLOWED_NAMES = frozenset(
    ["out.mp4", "out2.mp4", "other.mp4", "wide.mp4", "silent.mp4", "silent2.mp4"]
    + ["film_%02d.mp4" % i for i in range(FILMS)])
puts = []


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _path(self):
        requested = self.path.split("?")[0].lstrip("/")
        for allowed in ALLOWED_NAMES:
            if allowed == requested:
                return os.path.join(SRV, allowed)
        return None

    def do_PUT(self):
        p = self._path()
        if p is None:
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        left = int(self.headers.get("Content-Length", "0"))
        with open(p, "wb") as out:
            while left > 0:
                b = self.rfile.read(min(65536, left))
                if not b:
                    break
                out.write(b)
                left -= len(b)
        puts.append(os.path.basename(p))
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        p = self._path()
        if p is None or not os.path.isfile(p):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        size = os.path.getsize(p)
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m and m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
                status = 206
        end = min(end, size - 1)
        n = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(n))
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        with open(p, "rb") as f:
            f.seek(start)
            left = n
            while left > 0:
                b = f.read(min(65536, left))
                if not b:
                    break
                self.wfile.write(b)
                left -= len(b)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


srv = Server(("127.0.0.1", PORT), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

import app  # noqa: E402

app.validate_fetch_url = lambda u: (True, None)
import url_guard  # noqa: E402

url_guard._safe_fetch_url = lambda u: u
BASE = "http://127.0.0.1:%d" % PORT
failed = []


def check(name, ok, got=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name} {got}")
    if not ok:
        failed.append(name)


def run(*cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def make_film(name, length, extra_audio=0.0, size="320x180", audio=True):
    """Encoded with the container's settings. Black, then white from 1 s. Silence, then a tone from 1 s."""
    path = os.path.join(SRV, name)
    w, h = size.split("x")
    video = f"color=black:s={size}:r=24:d={length},drawbox=enable='gte(t,1)':x=0:y=0:w={w}:h={h}:color=white:t=fill"
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", video]
    if audio:
        cmd += ["-f", "lavfi", "-i", "aevalsrc='if(gte(t,1),0.5*sin(2*PI*1000*t),0)':s=48000:c=stereo",
                "-t", str(length + extra_audio), "-map", "0:v", "-map", "1:a",
                "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "18", path]
    run(*cmd)
    return path


def event_times(path):
    """(flash times from decoded frame timestamps, tone times from the sample count)."""
    video = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", path, "-map", "0:v:0", "-vf", "scale=8:8,format=gray,showinfo",
         "-fps_mode", "passthrough", "-f", "rawvideo", "-"], capture_output=True, check=True)
    times = [float(x) for x in re.findall(rb"pts_time:([0-9.]+)", video.stderr)]
    lit = [sum(video.stdout[i * 64:(i + 1) * 64]) / 64 > 128 for i in range(len(times))]
    flashes = [times[i] for i in range(1, len(lit)) if lit[i] and not lit[i - 1]]

    audio = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000",
                            "-f", "s16le", "-"], capture_output=True, check=True)
    samples = array.array("h")
    samples.frombytes(audio.stdout[:len(audio.stdout) // 2 * 2])
    window = 48
    loud = [max(abs(x) for x in samples[i:i + window]) > 2000 for i in range(0, len(samples) - window, window)]
    tones = [i * window / 48000 for i in range(1, len(loud)) if loud[i] and not loud[i - 1]]
    return flashes, tones


def spread(path):
    flashes, tones = event_times(path)
    if len(flashes) != FILMS or len(tones) != FILMS:
        return None, (len(flashes), len(tones))
    offsets = [t - f for f, t in zip(flashes, tones)]
    return max(offsets) - min(offsets), [round(o * 1000, 1) for o in offsets]


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def body(names, out, sig="a"):
    return {"films": [{"url": f"{BASE}/{n}?X-Amz-Signature={sig}"} for n in names],
            "outputUrl": f"{BASE}/{out}?X-Amz-Signature={sig}", "outputKey": out}


def refused(name, b, status, text):
    before = len(puts)
    try:
        asyncio.run(app._join_films_work(b))
        check(name, False, "accepted")
    except app._JobError as e:
        check(name, e.status == status and text in e.message and len(puts) == before, e.message)


def main():
    try:
        names = []
        for i in range(FILMS):
            name = "film_%02d.mp4" % i
            make_film(name, 2.0 + i * 0.13, extra_audio=0.021 + 0.013 * (i % 2))
            names.append(name)

        result = asyncio.run(app._join_films_work(body(names, "out.mp4", "a")))
        out = os.path.join(SRV, "out.mp4")
        check("the join reports ok and reached one PUT", result["ok"] and puts == ["out.mp4"], puts)
        total = sum(2.0 + i * 0.13 for i in range(FILMS))
        check("the join is as long as its films", abs(result["durationSeconds"] - total) < 0.5,
              (result["durationSeconds"], total))
        check("it reports each film and its offset",
              result["films"] == FILMS and len(result["filmOffsetsSeconds"]) == FILMS
              and result["filmOffsetsSeconds"][0] == 0.0, result["filmOffsetsSeconds"])
        codecs = run("ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", out).stdout.split()
        check("one video and one audio track", sorted(codecs) == ["aac", "h264"], codecs)

        # The video is copied, packet for packet.
        def video_md5(paths):
            lst = os.path.join(ROOT, "v.txt")
            with open(lst, "w") as f:
                f.write("\n".join(f"file '{p}'" for p in paths) + "\n")
            return run("ffmpeg", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-map", "0:v:0",
                       "-f", "md5", "-").stdout.strip()
        check("the picture is the same picture",
              video_md5([out]) == video_md5([os.path.join(SRV, n) for n in names]))

        flashes, _tones = event_times(out)
        worst = max(abs(off + 1.0 - f) for off, f in zip(result["filmOffsetsSeconds"], flashes))
        check("each reported offset is where its film starts, within a frame", worst < 1 / 24, f"{worst * 1000:.1f} ms")

        encoded, offsets = spread(out)
        lst = os.path.join(ROOT, "copy.txt")
        with open(lst, "w") as f:
            f.write("\n".join(f"file '{os.path.join(SRV, n)}'" for n in names) + "\n")
        copied_path = os.path.join(ROOT, "copied.mp4")
        run("ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", copied_path)
        copied, copied_offsets = spread(copied_path)
        print("offsets, encoded audio, ms:", offsets)
        print("offsets, plain copy, ms:   ", copied_offsets)
        check("the instrument saw every film in both joins", encoded is not None and copied is not None)
        check(f"audio sync spread is under {SPREAD_LIMIT_S * 1000:.0f} ms", encoded is not None and encoded < SPREAD_LIMIT_S,
              f"{encoded * 1000:.1f} ms" if encoded is not None else offsets)
        check("the plain copy control measures worse, so this test can tell them apart",
              copied is not None and encoded is not None and copied > encoded,
              f"{copied * 1000:.1f} ms" if copied is not None else copied_offsets)

        # A restart: the job table is gone, the caller re-submits with fresh signatures to another run.
        first = sha(out)
        job_id = app._join_job_id(body(names, "out.mp4", "a"))
        app.JOBS.clear()
        again = asyncio.run(app._join_films_work(body(names, "out.mp4", "b")))
        check("a re-run gets the same job id", job_id == app._join_job_id(body(names, "out.mp4", "b")))
        check("a re-run writes the same bytes", sha(out) == first, again["bytes"])

        # Refusals, on real files, before any upload.
        make_film("wide.mp4", 2.0, size="640x360")
        refused("a different frame is refused before any join", body([names[0], "wide.mp4"], "other.mp4"), 422, "width")
        make_film("silent.mp4", 2.0, audio=False)
        refused("one silent film is refused", body([names[0], "silent.mp4"], "other.mp4"), 422, "no audio track")
        make_film("silent2.mp4", 2.0, audio=False)
        n = len(puts)
        silent = asyncio.run(app._join_films_work(body(["silent.mp4", "silent2.mp4"], "other.mp4")))
        check("films that are all silent join, with no audio track",
              silent["hasAudio"] is False and silent["audioSeconds"] is None and len(puts) == n + 1, silent["hasAudio"])

        b = body(names[:2], "other.mp4")
        b["films"][1]["url"] = f"{BASE}/film_07.mp4x?X-Amz-Signature=SECRETSIG"
        try:
            asyncio.run(app._join_films_work(b))
            check("a film that will not read is refused", False)
        except app._JobError as e:
            check("a film that will not read is a 502 naming it, with no signature",
                  e.status == 502 and "films[1]" in e.message and "SECRETSIG" not in e.message, e.message)

        real = app.MAX_FILM_BYTES
        try:
            app.MAX_FILM_BYTES = 1000
            refused("a join over one upload is refused before any join", body(names, "other.mp4"), 413, "limit of one upload")
        finally:
            app.MAX_FILM_BYTES = real

        # A film lost inside the join. A real join of all but the last part, so the real guard has to see it.
        real_join = app._concat_hard_urls

        def dropping(urls, *a, **k):
            return real_join(urls[:-1], *a, **k)
        try:
            app._concat_hard_urls = dropping
            refused("a film dropped inside the join fails with no upload", body(names, "other.mp4"), 500, "dropped footage")
        finally:
            app._concat_hard_urls = real_join
    finally:
        srv.shutdown()
        shutil.rmtree(ROOT, ignore_errors=True)
    print(f"failed={len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
