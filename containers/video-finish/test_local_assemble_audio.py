"""Real-ffmpeg proof that a talking film's own assemble keeps its dialogue in time (cf#1167).

    python3 test_local_assemble_audio.py

Needs ffmpeg/ffprobe on PATH and aiohttp. NOT run in container-tests CI, for the same runner reason ci.yml
gives for test_local.py. test_join_audio_args.py is the CI half.

The film is 25 talking clips of 2 to 4.2 s, each with a white flash and a short tone at 1 s, and audio 30 ms
longer than its video, which is the shape a real clip has. `_assemble(keep_clip_audio=True)` is real code end to
end: normalize with ensure_audio, join, then the bed-less finalize. Each clip's offset is tone time less flash
time. Flash time is a decoded frame's timestamp. Tone time is the SAMPLE COUNT from the start of the decoded
audio with no filter, which is what a player that plays samples in order hears, and what the bed mix (amix)
reads. Do not measure this with silencedetect or any timestamp reading; see test_local_join_films.py.

THE CONTROL. The same film joined by plain stream copy must measure worse, or this test cannot tell the two apart.
Measured on ffmpeg 9.0.2: plain copy 586 ms late at the last clip; the one audio encode 0.0 ms spread.
"""
import array
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("LOCAL_FINISH_TOKEN", "test-token")

import app

CLIPS = 25
SPREAD_LIMIT_S = 0.010
CONTROL_MIN_S = 0.100
failed = []


def check(name, ok, got=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name} {got}")
    if not ok:
        failed.append(name)


def run(*cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def make_clip(path, length):
    video = f"color=black:s=320x180:r=25:d={length},drawbox=enable='gte(t,1)':x=0:y=0:w=320:h=180:color=white:t=fill"
    run("ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", video, "-f", "lavfi", "-i",
        "aevalsrc='if(gte(t,1)*lt(t,1.2),0.5*sin(2*PI*1000*t),0)':s=48000:c=stereo", "-t", f"{length + 0.03:.3f}",
        "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "18", path)


def offsets(path):
    v = subprocess.run(["ffmpeg", "-v", "info", "-i", path, "-map", "0:v:0", "-vf", "scale=8:8,format=gray,showinfo",
                        "-fps_mode", "passthrough", "-f", "rawvideo", "-"], capture_output=True, check=True)
    times = [float(x) for x in re.findall(rb"pts_time:([0-9.]+)", v.stderr)]
    lit = [sum(v.stdout[i * 64:(i + 1) * 64]) / 64 > 128 for i in range(len(times))]
    flashes = [times[i] for i in range(1, len(lit)) if lit[i] and not lit[i - 1]]
    a = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000",
                        "-f", "s16le", "-"], capture_output=True, check=True)
    s = array.array("h")
    s.frombytes(a.stdout[:len(a.stdout) // 2 * 2])
    w = 48
    loud = [max(abs(x) for x in s[i:i + w]) > 2000 for i in range(0, len(s) - w, w)]
    tones = [i * w / 48000 for i in range(1, len(loud)) if loud[i] and not loud[i - 1]]
    if len(flashes) != CLIPS or len(tones) != CLIPS:
        return None, (len(flashes), len(tones))
    return [t - f for f, t in zip(flashes, tones)], None


def assemble(root, srcs, label):
    work = os.path.join(root, label)
    os.makedirs(work)
    out = app._assemble(work, srcs, None, 320, 180, 25, 23, "veryfast", 0.0, 1, keep_clip_audio=True)[0]
    return out


def main():
    root = tempfile.mkdtemp(prefix="e2e-assemble-audio-")
    try:
        srcs = []
        for i in range(CLIPS):
            p = os.path.join(root, f"clip_{i:02d}.mp4")
            make_clip(p, 2.0 + (i % 7) * 0.37)
            srcs.append((p, None))

        fixed = assemble(root, srcs, "fixed")
        off, bad = offsets(fixed)
        check("every flash and tone found in the assembled film", off is not None, bad or "")
        if off:
            spread = max(off) - min(off)
            check(f"talking assemble: spread under {SPREAD_LIMIT_S * 1000:.0f} ms by sample count",
                  spread < SPREAD_LIMIT_S, f"{spread * 1000:.1f} ms, last {off[-1] * 1000:.1f} ms")

        real = app._join_output_args
        app._join_output_args = lambda audio: ["-c", "copy"]
        try:
            control = assemble(root, srcs, "control")
        finally:
            app._join_output_args = real
        coff, bad = offsets(control)
        check("control: every flash and tone found", coff is not None, bad or "")
        if coff:
            cspread = max(coff) - min(coff)
            check(f"control: plain copy measures worse (over {CONTROL_MIN_S * 1000:.0f} ms), so the instrument sees it",
                  cspread > CONTROL_MIN_S, f"{cspread * 1000:.1f} ms")
    finally:
        shutil.rmtree(root, ignore_errors=True)
    if failed:
        print(f"{len(failed)} FAILED")
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
