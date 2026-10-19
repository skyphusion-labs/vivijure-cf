"""Real-ffmpeg proof for concat_guard (cf#784) -- drives the guard against ACTUAL
concatenated video, not arithmetic. Mirrors test_local.py: needs ffmpeg/ffprobe on
PATH, no R2, no network. NOT run in container-tests CI, for the same runner reason
ci.yml gives for test_local.py's siblings.

    python3 test_local_concat_guard.py

WHY THIS FILE IS THE BLOCKER FOR WIRING THE GUARD IN

test_concat_guard.py validates REFUSAL: given numbers describing a dropped part, the
guard raises. That is the cheap half. It cannot validate PERMISSION -- that a real,
CORRECT render still passes -- because the tolerance moved from 15 percent slop to two
frames, and whether real normalized clips concat to within two frames of their probed
sum is a question about ffmpeg, not about arithmetic. A stubbed duration encodes my own
assumption about that and proves nothing.

So this file exists to answer exactly one question before `_assemble` is allowed to
adopt the new guard: **does a genuinely correct two-level concat of real encoded clips
land inside the frame tolerance?** If it does not, the tolerance is wrong and tightening
it would refuse honest films -- a far worse failure than the blindness it fixes.

ARM 1 (GREEN, the one that matters): real clips, real normalize, real batch concats,
real final join of partials. Must pass at BOTH levels.
ARM 2 (RED): the same final join with one partial deliberately withheld -- the dropped
batch that a 0.85 ratio cannot see once there are 7 or more of them.
"""
import os
import subprocess
import sys
import tempfile

import concat_guard as cg

FPS = 24
W, H = 160, 120
N_PARTIALS = 8          # >= 7, where the old ratio guard goes blind
CLIPS_PER_BATCH = 3


def _run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def _probe(path):
    out = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "csv=p=0", path]).stdout.strip()
    return float(out)


def _concat(paths, out):
    lst = out + ".txt"
    with open(lst, "w") as f:
        f.write("\n".join("file '%s'" % p for p in paths) + "\n")
    _run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
          "-i", lst, "-c", "copy", out])


def main():
    if not os.environ.get("SKIP_FFMPEG_CHECK"):
        try:
            _run(["ffmpeg", "-version"])
            _run(["ffprobe", "-version"])
        except Exception as e:  # noqa: BLE001
            print("[SKIP] ffmpeg/ffprobe not usable here: %s" % e)
            print("This test is evidence only where a real encoder runs. Not a pass.")
            return 2

    failures = []
    work = tempfile.mkdtemp(prefix="concat-guard-test-")
    partials, partial_durs = [], []

    for b in range(N_PARTIALS):
        norms = []
        for i in range(CLIPS_PER_BATCH):
            src = os.path.join(work, "b%02d_c%02d.mp4" % (b, i))
            # Vary duration so a uniform-length coincidence cannot mask an error.
            # Awkward duration AND a source fps that is not the target: the real path
            # normalizes arbitrary i2v output to a fixed fps, and that requantisation
            # is precisely what a two-frame tolerance has to survive.
            dur = 1.0 + 0.37 * i
            src_fps = (30, 25, 23.976)[i % 3]
            raw = src + ".raw.mp4"
            _run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                  "-i", "testsrc=size=%dx%d:rate=%s:duration=%.3f" % (W, H, src_fps, dur),
                  "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
                  "-pix_fmt", "yuv420p", raw])
            # Mirror _normalize: scale/pad/fps through libx264, audio stripped.
            _run(["ffmpeg", "-y", "-loglevel", "error", "-i", raw,
                  "-vf", "scale=%d:%d:force_original_aspect_ratio=decrease,"
                         "pad=%d:%d:(ow-iw)/2:(oh-ih)/2,fps=%d" % (W, H, W, H, FPS),
                  "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
                  "-pix_fmt", "yuv420p", src])
            os.remove(raw)
            norms.append(src)
        norm_durs = [_probe(p) for p in norms]
        partial = os.path.join(work, "partial_%02d.mp4" % b)
        _concat(norms, partial)
        # INNER level: this batch must not have lost a clip.
        try:
            exp, slack = cg.assert_no_dropped_parts(_probe(partial), norm_durs,
                                                    level="batch %d/%d" % (b + 1, N_PARTIALS), fps=FPS)
            print("[PASS] batch %d/%d intact: assembled %.3fs vs expected %.3fs (slack %.4fs)"
                  % (b + 1, N_PARTIALS, _probe(partial), exp, slack))
        except cg.ConcatDropError as e:
            failures.append("INNER guard false-positived on a correct batch: %s" % e)
            print("[FAIL] %s" % e)
        partials.append(partial)
        partial_durs.append(_probe(partial))

    # ---- ARM 1, GREEN: the correct outer join must PASS. This is the permission test.
    film = os.path.join(work, "film.mp4")
    _concat(partials, film)
    film_dur = _probe(film)
    try:
        exp, slack = cg.assert_no_dropped_parts(film_dur, partial_durs,
                                                level="final join of partials", fps=FPS)
        print("[PASS] correct outer join of %d partials accepted: %.3fs vs expected %.3fs "
              "(shortfall %.4fs, tolerance %.4fs)"
              % (N_PARTIALS, film_dur, exp, exp - film_dur, slack))
    except cg.ConcatDropError as e:
        failures.append(
            "OUTER guard REFUSED a correct film -- the frame tolerance is too tight for real "
            "concat rounding, and wiring this into _assemble would break honest renders: %s" % e)
        print("[FAIL] %s" % e)

    # ---- ARM 2, RED: drop one whole partial. Must be caught, where 0.85 could not see it.
    short = os.path.join(work, "short.mp4")
    _concat(partials[:-1], short)
    short_dur = _probe(short)
    ratio = short_dur / sum(partial_durs)
    old_would_fire = short_dur < sum(partial_durs) * 0.85
    try:
        cg.assert_no_dropped_parts(short_dur, partial_durs,
                                   level="final join of partials", fps=FPS)
        failures.append("OUTER guard MISSED a dropped partial (ratio %.4f)" % ratio)
        print("[FAIL] dropped partial NOT caught, ratio %.4f" % ratio)
    except cg.ConcatDropError as e:
        print("[PASS] dropped partial CAUGHT at the outer level: %s" % e)
        print("       measured ratio %.4f; the old 0.85 ratio guard would have fired: %s"
              % (ratio, old_would_fire))
        if old_would_fire:
            failures.append(
                "control weak: this configuration is one the OLD guard also caught, so it does "
                "not demonstrate the fix. Raise N_PARTIALS.")

    print("\n%d failures" % len(failures))
    for f in failures:
        print("  FAILED: %s" % f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
