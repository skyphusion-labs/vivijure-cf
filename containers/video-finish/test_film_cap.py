"""The film-sized limits for routes that take a whole film (cf#1129). Stdlib plus app.py, no ffmpeg.

    python3 test_film_cap.py

Exits non-zero on any failed assertion. tests/film-byte-cap-1129.test.ts holds MAX_FILM_BYTES equal to core.
A real film over 256 MB through the real routes is test_local_film_cap.py.
"""
import asyncio
import os
import sys
import tempfile

import app


class FakeContent:
    def __init__(self, total):
        self.total = total

    async def iter_chunked(self, n):
        sent = 0
        while sent < self.total:
            size = min(n, self.total - sent)
            sent += size
            yield b"x" * size


class FakeResp:
    status = 200

    def __init__(self, total):
        self.content = FakeContent(total)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def main():
    failures = []

    def check(name, ok, got=""):
        print(f"{'ok  ' if ok else 'FAIL'} {name} {got}")
        if not ok:
            failures.append(name)

    source = open(app.__file__, encoding="utf-8").read()
    check("no whole-film route is left on the clip cap",
          "_download(s, video_url, film_path, MAX_CLIP_BYTES)" not in source
          and "_download(s, video_url, clip_path, MAX_CLIP_BYTES)" not in source)
    check("titles and captions take a film", source.count("_download(s, video_url, film_path, MAX_FILM_BYTES)") == 2)
    check("frames takes a film", "_download(s, video_url, clip_path, MAX_FILM_BYTES)" in source)
    check("a remux takes a film and a clip stays a clip", "input_cap = MAX_FILM_BYTES if remux_audio_only else MAX_CLIP_BYTES" in source)
    check("/inspect stays a clip", "_download(s, clip_url, clip_path, MAX_CLIP_BYTES)" in source)
    check("no film upload is left on the 120 s bound", "await _put_file(s, output_url, out_path)" in source
          and source.count("ClientTimeout(total=UPLOAD_TIMEOUT_S)) as s:\n            out_size") == 0
          and source.count("ClientTimeout(total=UPLOAD_TIMEOUT_S)) as s:\n            size") == 0
          and source.count("ClientTimeout(total=UPLOAD_TIMEOUT_S)) as s:\n                await _put_file") == 0)
    check("the titles source is removed before the output is joined",
          source.index("os.remove(film_path)") < source.index('out = os.path.join(work, "with_titles.mp4")'))
    t = app._film_timeout()
    check("a film transfer outlasts 120 s and still stops a dead connection", t.total > 120 and t.sock_read == app.FILM_TRANSFER_STALL_S, t)

    # The cap itself, through the real _download over a fake stream with a sparse write.
    work = tempfile.mkdtemp(prefix="filmcap-")
    orig = app.guarded_get
    try:
        over_clip = app.MAX_CLIP_BYTES + 1024 * 1024
        app.guarded_get = lambda *a, **k: FakeResp(over_clip)
        ok, info = asyncio.run(app._download(None, "https://x/f", os.path.join(work, "a"), app.MAX_FILM_BYTES))
        check("a film over 256 MB downloads", ok and info == over_clip, info)
        ok, info = asyncio.run(app._download(None, "https://x/f", os.path.join(work, "b"), app.MAX_CLIP_BYTES))
        check("the clip cap still refuses it", not ok and info == "too large", info)
    finally:
        app.guarded_get = orig
        for name in ("a", "b"):
            path = os.path.join(work, name)
            if os.path.exists(path):
                os.remove(path)
        os.rmdir(work)

    orig_probe = app._probe_duration
    try:
        app._probe_duration = lambda _p: 10.0
        check("a short film keeps the floor", app._film_encode_timeout("x") == app.FFMPEG_TIMEOUT, app._film_encode_timeout("x"))
        app._probe_duration = lambda _p: 3600.0
        check("an hour gets three hours", app._film_encode_timeout("x") == 10800, app._film_encode_timeout("x"))
    finally:
        app._probe_duration = orig_probe

    print(f"failed={len(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
