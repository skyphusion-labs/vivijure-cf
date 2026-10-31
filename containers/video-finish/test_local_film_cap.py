"""Real-route proof for cf#1129: a film over 256 MB through POST /film-titles, /subtitle, /frames and a remux.

Runs the real aiohttp app, a local origin for the film and the PUTs, and real ffmpeg. Only the URL guard is opened,
for the local origin. Needs ffmpeg with drawtext and libass. Set FRAME_TEXT_FONT when it has no
fontconfig. Not in CI: it writes about 1 GB and encodes for minutes.

    python3 test_local_film_cap.py [work_dir]

Prints the real sizes, and the largest the work dir reached for each route.
"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from aiohttp import ClientSession, ClientTimeout, web

import app
import url_guard

FONT = os.environ.get("FRAME_TEXT_FONT")
TARGET = 300 * 1024 * 1024


def make_film(path, seconds=12):
    """High-entropy video at x264 crf 1, large in bytes and short in time."""
    size = 300
    while True:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=s=1280x720:r=24:d={seconds}",
             "-f", "lavfi", "-i", f"sine=frequency=330:duration={seconds}",
             "-vf", f"noise=alls={size // 3}:allf=t", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "1",
             "-pix_fmt", "yuv420p", "-c:a", "aac", path],
            check=True,
        )
        if os.path.getsize(path) > TARGET:
            return
        seconds *= 2


class Peak(threading.Thread):
    """Samples how many bytes this process's temp work dirs hold."""

    def __init__(self, root):
        super().__init__(daemon=True)
        self.root, self.peak, self.done = root, 0, False

    def run(self):
        while not self.done:
            total = 0
            for d, _, files in os.walk(self.root):
                for f in files:
                    try:
                        total += os.path.getsize(os.path.join(d, f))
                    except OSError:
                        pass
            self.peak = max(self.peak, total)
            time.sleep(0.25)


async def main(work):
    film = os.path.join(work, "film.mp4")
    make_film(film)
    film_bytes = os.path.getsize(film)
    print(f"film {film_bytes} bytes, over the clip cap: {film_bytes > app.MAX_CLIP_BYTES}", flush=True)
    assert film_bytes > app.MAX_CLIP_BYTES

    bed = os.path.join(work, "bed.m4a")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=5", "-c:a", "aac", bed], check=True)

    received = {}

    async def get_film(req):
        return web.FileResponse(film if req.match_info["name"] == "film" else bed)

    async def put(req):
        path = os.path.join(work, "out_" + req.match_info["name"])
        with open(path, "wb") as f:
            async for chunk in req.content.iter_chunked(1024 * 1024):
                f.write(chunk)
        received[req.match_info["name"]] = path
        return web.Response(status=200)

    origin = web.Application(client_max_size=1024 ** 4)
    origin.router.add_get("/get/{name}", get_film)
    origin.router.add_put("/put/{name}", put)
    origin_runner = web.AppRunner(origin)
    await origin_runner.setup()
    await web.TCPSite(origin_runner, "127.0.0.1", 8931).start()

    os.environ["LOCAL_FINISH_TOKEN"] = "test"
    # The local origin is plain http on loopback, which the guard rightly refuses. Nothing else is changed.
    url_guard.validate_fetch_url = lambda _u: (True, "")
    url_guard._safe_fetch_url = lambda u: u
    app.validate_fetch_url = url_guard.validate_fetch_url

    real_filter = app._title_card_filter
    real_sub = app._subtitle_filter
    if FONT:
        app._title_card_filter = lambda *a, **k: real_filter(*a, **k).replace("font='DejaVu Sans'", f"fontfile='{FONT}'")
        app._subtitle_filter = lambda *a, **k: real_sub(*a, **k).replace(":force_style=", f":fontsdir='{os.path.dirname(FONT)}':force_style=")

    tmp = os.path.join(work, "tmp")
    os.makedirs(tmp, exist_ok=True)
    tempfile.tempdir = tmp

    application = app.make_app() if hasattr(app, "make_app") else app.app
    runner = web.AppRunner(application)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 8932).start()

    base = "http://127.0.0.1:8931"
    srt = "1\n00:00:01,000 --> 00:00:04,000\nA caption on a large film.\n"
    cases = [
        ("film-titles", "/film-titles", {"videoUrl": f"{base}/get/film", "outputUrl": f"{base}/put/titles", "outputKey": "k", "width": 1280, "height": 720, "fps": 24, "preset": "ultrafast", "title": {"text": "Large film", "seconds": 2}}, "titles"),
        ("subtitle", "/subtitle", {"videoUrl": f"{base}/get/film", "outputUrl": f"{base}/put/subs", "outputKey": "k", "srt": srt, "mode": "burn", "preset": "ultrafast", "style": {"font": "DejaVu Sans", "fontSize": 28}}, "subs"),
        ("mux", "/finish", {"clips": [{"url": f"{base}/get/film"}], "remuxAudioOnly": True, "audioUrl": f"{base}/get/bed", "outputUrl": f"{base}/put/mux", "outputKey": "k"}, "mux"),
        ("frames", "/frames", {"videoUrl": f"{base}/get/film", "outputUrl": f"{base}/put/frames", "count": 4}, "frames"),
    ]
    failed = []
    headers = {"authorization": "Bearer " + os.environ["LOCAL_FINISH_TOKEN"]}
    async with ClientSession(timeout=ClientTimeout(total=1800)) as s:
        for name, path, body, key in cases:
            peak = Peak(tmp)
            peak.start()
            t0 = time.monotonic()
            async with s.post("http://127.0.0.1:8932" + path, json=body, headers=headers) as r:
                text = await r.text()
                status = r.status
            peak.done = True
            peak.join()
            out = received.get(key)
            size = os.path.getsize(out) if out else 0
            good = status == 200 and size > 0
            print(f"{'ok  ' if good else 'FAIL'} {name}: HTTP {status}, output {size} bytes, {time.monotonic() - t0:.0f}s, peak work dir {peak.peak} bytes = {peak.peak / film_bytes:.2f}x the film", flush=True)
            if not good:
                print("     " + text[:300], flush=True)
                failed.append(name)
            if out and name != "frames":
                probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "compact=p=0", out], capture_output=True, text=True)
                print("     " + " ".join(probe.stdout.split()), flush=True)
            if out:
                os.remove(out)
    await runner.cleanup()
    await origin_runner.cleanup()
    return 1 if failed else 0


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="filmcap-local-")
    os.makedirs(root, exist_ok=True)
    try:
        sys.exit(asyncio.run(main(root)))
    finally:
        shutil.rmtree(root, ignore_errors=True)
