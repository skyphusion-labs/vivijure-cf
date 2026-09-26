"""Photometric identity gate (cf#532): does a finish step preserve the OUTPUT LEVEL of what it was
given, not merely its shape. This is a different question from #523 Layer 2's inspect_core, and it
is the one this issue exists because inspect_core cannot answer it.

inspect_core.judge() flags STRUCTURAL noise -- a clip that does not resemble its conditioning
keyframe, or a chromatic-noise signature. But a wrong-and-well-structured grade -- a bright
windowsill graded to a near-black night scene, still correctly shaped, still the right frame count
and dimensions, still passing every structural gate -- is invisible to it BY DESIGN: keyframe
similarity is a luma cross-correlation, which is scale/offset-invariant, so a uniform darkening does
not move the correlation coefficient at all. A check built to catch garbage cannot also catch a
correctly-shaped wrong answer; that needs an absolute level comparison, not a structural one.

Root cause this generalizes past: vivijure-blender#14. finish-blender ran an identity-preset grade
(gamma 1, lift 0, gain 1, sat 1 -- a mathematical no-op) and returned frames 3.3x darker with a red
cast. Every gate the estate owned passed: `degraded: 0`, correct frame count, valid mp4 structure,
inspect_core's noise heuristic (the frame was not noise, it was just wrong). Found by a human
looking at pixels after the fact. cf#532 is the general-purpose version of that same look, automated.

THE CHECK: decode a source frame and its corresponding finished-clip frame, compute each frame's
mean luma (YAVG), and assert the ratio sits within a tolerance derived from MEASUREMENT, not a
guess (cf#532 issue comment 5294980863, on the deployed door, now-fixed build, 3 of 3 replicas):

    identity-preset render through this decode(h264)->composite->encode(h264 crf18) path: 0.9926
    lossless round trip, same commit, no codec involved:                                  1.0038
    the known-bad pre-fix case, same codec:                                                0.298

The tolerance below is fifteen times narrower than the gap to the known-bad case, which is the
entire point of deriving it rather than guessing: an exact-1.00 expectation fails on CORRECT code
(the encode round trip alone costs ~0.7%), and a merely-plausible-looking range can absorb the
defect it exists to catch. This one cannot, without also failing normal encode loss.

CALIBRATION SCOPE, stated so it is not silently inherited: measured on `grade` job type only, 2 of 5
presets, 2 strengths, one clip, one 1280x720 source, 121 frames, through THIS container's specific
decode/composite/encode path. A different codec, crf, or resolution needs its own measurement; a
caller that reuses RATIO_TOLERANCE against a different pipeline without re-measuring is the next
instance of this issue's own class (a check whose basis nobody re-derived).

FAILS LOUD ON COULD-NOT-DECODE. An unread frame is not a passing frame -- the same
could-not-determine-is-not-a-determination rule that decided cp#335. `check_pair` and `check_shots`
raise DecodeFailure rather than returning a skip/unknown verdict when a side yields zero frames or a
degenerate (non-positive) luma; a caller that catches DecodeFailure and downgrades it to a pass is
reintroducing the exact gap this issue is closing.

SEMANTIC PRECONDITION (cf#567): this 2% luma check is only valid when the
operation is supposed to PRESERVE output level. That is an identity-preset
grade (preset=neutral at strength 1, or strength 0). A creative grade that
darkens on purpose would read wrecked while doing exactly what it was asked.
The natural caller is finish-blender after such a grade (it holds source and
output). video-finish still cannot call this unattended: it never sees the
pre-grade source.

NOT WIRED into video-finish concat/mux. `/photometric-check` exposes it as a
callable HTTP gate for any caller that holds both URLs.
"""
import inspect_core as ic

# Derived from measurement (cf#532 comment 5294980863), not guessed. See the module docstring for
# the three measured ratios this is calibrated against; 0.02 is fifteen times narrower than the gap
# to the known-bad case (0.298) and wider than both good arms (0.9926, 1.0038).
RATIO_TOLERANCE = 0.02

# cf#567: named so a caller cannot treat this as a generic quality score.
SEMANTIC_PRECONDITION = "identity_preserving"


class DecodeFailure(Exception):
    """A side of a pair yielded zero decodable frames, or a luma value too degenerate to form a
    ratio. Must never be caught and silently downgraded to a pass or a skip -- that is precisely
    the failure mode this module exists to close (cp#335's rule, applied here)."""


def frame_luma_mean(frame, size=ic.SAMPLE_SIZE):
    """Mean per-pixel luma (BT.601-ish gray, same weights as inspect_core.frame_gray_std) over an
    rgb24 frame. Pure. This is the YAVG the cf#532 derivation measured via ffmpeg's signalstats
    filter, computed here directly from the raw rgb24 samples inspect_core.sample_frames_rgb
    already produces -- no second ffmpeg filter graph needed for the same number."""
    n = size * size
    if not n:
        return 0.0
    total = 0.0
    for i in range(n):
        r, g, b = frame[i * 3], frame[i * 3 + 1], frame[i * 3 + 2]
        total += 0.299 * r + 0.587 * g + 0.114 * b
    return total / n


def clip_luma_mean(frames, size=ic.SAMPLE_SIZE):
    """Mean luma averaged across sampled frames. Pure. Raises DecodeFailure on an empty frame list:
    zero decoded frames is a decode failure, not a clip whose luma happens to be 0."""
    if not frames:
        raise DecodeFailure("zero frames decoded")
    means = [frame_luma_mean(f, size) for f in frames]
    return sum(means) / len(means)


def ratio_verdict(src_luma, output_luma, tolerance=RATIO_TOLERANCE):
    """The gate's own math, isolated from all I/O so it is exactly unit-testable. Pure.

    Raises DecodeFailure if src_luma is non-positive: a true-black source makes the ratio
    UNDEFINED, not merely small, and reporting a computed 0.0 or inf as if it were a measured ratio
    would be the same silent-wrong-answer shape this module exists to prevent."""
    if src_luma <= 0:
        raise DecodeFailure(
            f"source luma is non-positive ({src_luma}); ratio is undefined, not measurable"
        )
    ratio = output_luma / src_luma
    ok = abs(ratio - 1.0) <= tolerance
    return {
        "verdict": "ok" if ok else "wrecked",
        "ratio": round(ratio, 4),
        "tolerance": tolerance,
        "src_luma": round(src_luma, 3),
        "output_luma": round(output_luma, 3),
    }


def check_pair(src_path, output_path, sample_frames_fn=ic.sample_frames_rgb, size=ic.SAMPLE_SIZE):
    """I/O orchestration: decode both clips, compute the ratio verdict. `sample_frames_fn` is
    injected (defaults to inspect_core's real ffmpeg wrapper) so this is exactly unit-testable
    without a real decode -- mirrors inspect_core.inspect's split between pure math and I/O."""
    src_frames = sample_frames_fn(src_path)
    output_frames = sample_frames_fn(output_path)
    src_luma = clip_luma_mean(src_frames, size)
    output_luma = clip_luma_mean(output_frames, size)
    result = ratio_verdict(src_luma, output_luma)
    result["src_frames"] = len(src_frames)
    result["output_frames"] = len(output_frames)
    return result


def check_shots(pairs, sample_frames_fn=ic.sample_frames_rgb, size=ic.SAMPLE_SIZE):
    """Check multiple (src_path, output_path) shot pairs and report WITH A DENOMINATOR, so a
    partial or zero count is legible rather than silently absorbed into one pass/fail bit.

    A pair that fails to decode ABORTS the batch rather than being silently dropped or counted as
    passed -- fail loud, not skip -- but the raised DecodeFailure carries how many shots were
    successfully checked before it, so the denominator survives the failure path too."""
    results = []
    for i, (src_path, output_path) in enumerate(pairs):
        try:
            result = check_pair(src_path, output_path, sample_frames_fn, size)
        except DecodeFailure as e:
            raise DecodeFailure(
                f"shot {i} of {len(pairs)} failed to decode ({e}); "
                f"{len(results)} of {len(pairs)} shots checked before this failure"
            ) from e
        results.append(result)
    wrecked = [r for r in results if r["verdict"] == "wrecked"]
    return {
        "verdict": "ok" if not wrecked else "wrecked",
        "shots_checked": len(results),
        "shots_total": len(pairs),
        "shots_wrecked": len(wrecked),
        "results": results,
    }
