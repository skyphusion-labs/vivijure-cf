"""Real-ffmpeg proof of vivijure-cf#1338: a held clip lasts its planned seconds by cloning its last frame,
and a clip's video always lasts as long as its own audio.

    python3 test_local_hold.py

Needs ffmpeg/ffprobe on PATH and aiohttp. NOT run in container-tests CI, for the same runner reason ci.yml
gives for test_local.py. test_hold.py is the CI half.

The clip is the shape InfiniteTalk delivered for a 0.43 s line (film-666e3bd4, 2026-11-06): 9 frames at
25 fps (0.36 s) of video and 0.43 s of audio. The last frame is white and every earlier one black, so a
cloned last frame can be told from any other frame by its brightness.
"""
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("LOCAL_FINISH_TOKEN", "test-token")

import app

failed = []
FRAME = 1 / 25


def check(name, ok, got=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name} {got}")
    if not ok:
        failed.append(name)


def run(*cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def make_clip(path, video_s=0.36, audio_s=0.43):
    # Black, then white from the last frame on: the clone of the last frame is white.
    video = f"color=black:s=320x180:r=25:d={video_s},drawbox=enable='gte(t,{video_s - FRAME - 0.001})':x=0:y=0:w=320:h=180:color=white:t=fill"
    run("ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", video, "-f", "lavfi", "-i",
        f"sine=f=440:sample_rate=48000:d={audio_s}", "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "128k",
        "-ar", "48000", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "18", path)


def stream(path, sel):
    return app._probe_stream_duration(path, sel)


def mean_luma_at(path, t):
    out = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", "-vf", "scale=8:8,format=gray",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    return sum(out) / max(1, len(out))


def assemble(root, label, srcs, keep_clip_audio):
    work = os.path.join(root, label)
    os.makedirs(work)
    return app._assemble(work, srcs, None, 320, 180, 25, 23, "veryfast", 0.0, 1, keep_clip_audio=keep_clip_audio)


def main():
    root = tempfile.mkdtemp(prefix="e2e-hold-")
    try:
        clip = os.path.join(root, "it.mp4")
        make_clip(clip)
        check("fixture: 0.36 s of video", abs(stream(clip, "v:0") - 0.36) < 0.005, stream(clip, "v:0"))
        check("fixture: about 0.43 s of audio", abs(stream(clip, "a:0") - 0.43) < 0.03, stream(clip, "a:0"))
        check("fixture: the last frame is white and an early one black",
              mean_luma_at(clip, 0.32) > 200 and mean_luma_at(clip, 0.1) < 50)

        # ---- held to the plan, a talking film.
        out, secs, has_audio, durs = assemble(root, "held", [(clip, None, 2.0)], True)
        v, a = stream(out, "v:0"), stream(out, "a:0")
        check("held: the video lasts the planned 2 s", abs(v - 2.0) <= FRAME, v)
        check("held: the audio lasts 2 s too, padded and not cut", a is not None and abs(a - 2.0) <= 0.03, a)
        check("held: the added time is the last frame, cloned", mean_luma_at(out, 1.9) > 200, mean_luma_at(out, 1.9))
        check("held: the clip's own audio is still there at the start", has_audio)

        # ---- not held, a talking film: the video runs as long as its own audio (the 70 ms).
        out, secs, has_audio, durs = assemble(root, "audio", [(clip, None)], True)
        v, a = stream(out, "v:0"), stream(out, "a:0")
        check("talking: the video is no shorter than the audio", v + FRAME / 2 >= a, (v, a))
        check("talking: the audio is not cut", a is not None and a >= 0.42, a)

        # ---- the CONTROL: without the change the video stays 0.36 s. The instrument must see the gap.
        real = app._hold_extension
        app._hold_extension = lambda *a, **k: None
        try:
            out, *_ = assemble(root, "control", [(clip, None)], True)
        finally:
            app._hold_extension = real
        cv, ca = stream(out, "v:0"), stream(out, "a:0")
        check("control: with no extension the video is shorter than the audio, so the check above can fail",
              cv + FRAME / 2 < ca, (cv, ca))

        # ---- a silent film is held too, and a film of two clips trims its join off the held length.
        out, secs, has_audio, durs = assemble(root, "silent", [(clip, None, 2.0)], False)
        check("silent: held to 2 s", abs(stream(out, "v:0") - 2.0) <= FRAME, stream(out, "v:0"))
        out, secs, has_audio, durs = assemble(root, "two", [(clip, None, 2.0), (clip, None, 2.0)], True)
        check("two held clips: the first loses one frame at the join, the last keeps all 2 s",
              abs(durs[0] - (2.0 - FRAME)) <= FRAME and abs(durs[1] - 2.0) <= FRAME, durs)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print("all passed" if not failed else f"{len(failed)} failed: {failed}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
