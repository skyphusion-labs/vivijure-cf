"""cf#1167: every hard-cut join that keeps audio encodes it once, and a silent join still stream-copies.

    python3 test_join_audio_args.py

No ffmpeg, no network: `_run`, `_concat_hard_urls` and the probes are replaced, so this proves which ffmpeg
arguments each join is GIVEN. That the arguments hold the audio in time is test_local_assemble_audio.py, which
needs a real ffmpeg and measures by sample count.
"""
import asyncio
import os
import sys
import tempfile

os.environ.setdefault("LOCAL_FINISH_TOKEN", "test-token")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app

failed = []


def check(name, ok, got=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name} {got}")
    if not ok:
        failed.append(name)


def encodes_audio(cmd):
    return "-c:v" in cmd and cmd[cmd.index("-c:v") + 1] == "copy" and all(a in cmd for a in app.JOIN_AUDIO_ARGS) \
        and "0:a:0" in cmd and ["-c", "copy"] != cmd[-3:-1]


def plain_copy(cmd):
    return "-c" in cmd and cmd[cmd.index("-c") + 1] == "copy" and not any(a in cmd for a in app.JOIN_AUDIO_ARGS)


def capture(fn, *a, **k):
    seen = []
    real = app._run
    app._run = lambda cmd, timeout=None: seen.append(list(cmd))
    try:
        fn(*a, **k)
    finally:
        app._run = real
    return seen


def main():
    work = tempfile.mkdtemp(prefix="joinargs-")
    try:
        out = os.path.join(work, "o.mp4")
        cmds = capture(app._concat_hard, ["a.mp4", "b.mp4"], out, audio=True)
        check("_concat_hard(audio=True) copies video and encodes audio once", len(cmds) == 1 and encodes_audio(cmds[0]),
              cmds and " ".join(cmds[0][-14:]))
        cmds = capture(app._concat_hard, ["a.mp4", "b.mp4"], out)
        check("_concat_hard() with no kept audio still stream-copies", len(cmds) == 1 and plain_copy(cmds[0]))
        check("min_hard_comp is in the audio filter", any("min_hard_comp=0.01" in a for a in app.JOIN_AUDIO_ARGS))

        # The talking-film assemble: normalize is real code but its ffmpeg call is captured, so the
        # concat the assemble asks for is what is checked.
        real_probe, real_norm, real_mux = app._probe_duration, app._normalize, app._mux_bed_onto
        joins = []
        app._probe_duration = lambda p: 4.0 if str(p).endswith("_silent.mp4") else 2.0
        app._normalize = lambda *a, **k: None
        app._mux_bed_onto = lambda *a: (out, 4.0, True)
        real_concat = app._concat_hard
        app._concat_hard = lambda norms, o, audio=False: joins.append(audio)
        try:
            app._assemble(work, [("a.mp4", None), ("b.mp4", None)], None, 320, 180, 24, 23, "veryfast", 0.0, 1,
                          keep_clip_audio=True)
            app._assemble(work, [("a.mp4", None), ("b.mp4", None)], None, 320, 180, 24, 23, "veryfast", 0.0, 1,
                          keep_clip_audio=False)
        finally:
            app._probe_duration, app._normalize, app._mux_bed_onto = real_probe, real_norm, real_mux
            app._concat_hard = real_concat
        check("a talking film joins its clips with the audio encoded once", joins[:1] == [True], joins)
        check("a silent film joins its clips by stream copy", joins[1:2] == [False], joins)

        # A titled film: cards plus the film are joined with the audio encoded once when the film has sound.
        reals = (app._probe_audio, app._make_card, app._normalize, app._concat_hard, app._probe_duration)
        titled = []
        app._make_card = lambda *a, **k: None
        app._normalize = lambda *a, **k: None
        app._probe_duration = lambda p: 1.0
        app._concat_hard = lambda segs, o, audio=False: titled.append((len(segs), audio))
        try:
            for has in (True, False):
                app._probe_audio = lambda p, has=has: (has, 48000 if has else None, "stereo" if has else None)
                film = os.path.join(work, "film.mp4")
                open(film, "wb").close()
                app._assemble_film_titles(work, film, {"text": "T"}, {"lines": ["C"]}, 320, 180, 24, 23,
                                          "veryfast")
        finally:
            app._probe_audio, app._make_card, app._normalize, app._concat_hard, app._probe_duration = reals
        check("a titled film with sound joins its cards with the audio encoded once", titled[:1] == [(3, True)], titled)
        check("a silent titled film joins by stream copy", titled[1:2] == [(3, False)], titled)

        # The chunked path (cf#784): batches are joined, then the partials are joined by URL. Both joins must
        # encode the kept audio once. Downloads, uploads, encodes and probes are replaced; the joins are captured.
        for keep in (True, False):
            batch_joins, partial_args = [], []
            saved = {k: getattr(app, k) for k in ("_download", "_normalize_batch", "_concat_hard", "_probe_duration",
                                                  "assert_no_dropped_parts", "_put_file", "_concat_hard_urls",
                                                  "_mux_bed_onto", "MAX_BATCH_BYTES")}

            async def fake_download(s, url, dst, cap):
                with open(dst, "wb") as f:
                    f.write(b"x" * 10)
                return True, ""

            async def fake_put(s, url, path, label=None):
                return 1

            def fake_join_urls(urls, out, list_path, output_args=("-c", "copy"), timeout=None):
                partial_args.append(list(output_args))
                open(out, "wb").close()

            app._download = fake_download
            app._normalize_batch = lambda d, batch, total, **k: ([b[0] for b in batch], [2.0 for _ in batch])
            app._concat_hard = lambda norms, o, audio=False: (batch_joins.append(audio), open(o, "wb").close())
            app._probe_duration = lambda p: 2.0
            app.assert_no_dropped_parts = lambda *a, **k: None
            app._put_file = fake_put
            app._concat_hard_urls = fake_join_urls
            app._mux_bed_onto = lambda root, silent, audio, kca: (silent, 6.0, kca)
            app.MAX_BATCH_BYTES = 15  # two clips per batch, so three clips make two partials
            try:
                b = {"clips": [{"url": f"https://r2.example/c{i}.mp4"} for i in range(3)],
                     "outputUrl": "https://r2.example/out.mp4", "outputKey": "out.mp4", "keepClipAudio": keep}
                pool = [(f"https://r2.example/p{i}?put", f"https://r2.example/p{i}?get") for i in range(4)]
                asyncio.run(app._finish_chunked(b, pool, 0.0))
            finally:
                for k, v in saved.items():
                    setattr(app, k, v)
            label = "talking" if keep else "silent"
            check(f"chunked {label} film: every batch join encodes audio = {keep}",
                  len(batch_joins) == 2 and all(a is keep for a in batch_joins), batch_joins)
            want = app._join_output_args(keep)
            check(f"chunked {label} film: the partials join gets the {'encoded-audio' if keep else 'copy'} args",
                  partial_args == [want], partial_args)

        # The output args handed to the partials join on the chunked path.
        check("_join_output_args(True) is the encoded-audio form", encodes_audio(["x", *app._join_output_args(True), "o"]))
        check("_join_output_args(False) is a stream copy", app._join_output_args(False) == ["-c", "copy"])
    finally:
        import shutil
        shutil.rmtree(work, ignore_errors=True)
    if failed:
        print(f"{len(failed)} FAILED")
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
