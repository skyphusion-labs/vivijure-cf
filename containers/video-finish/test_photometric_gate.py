"""Local unit tests for photometric_gate (cf#532) -- stdlib only, no ffmpeg, no network. Proves the
pure ratio math and the fail-loud-on-could-not-decode behaviour. Mirrors test_inspect.py's style.

Run:  python3 test_photometric_gate.py
Exits non-zero on any failed assertion.

Real-ffmpeg proof that the gate discriminates on ACTUAL decoded frames (RED on a deliberately
wrecked frame, GREEN on a real lossy encode round trip) lives in test_local.py, not here -- this
file only proves the math, matching the container-tests CI split already used for
inspect_core/test_inspect.py vs the audio containers' ffmpeg-dependent test_local.py.
"""
import sys

import photometric_gate as pg

SZ = 4  # tiny synthetic frames


def solid(r, g, b, size=SZ):
    return bytes([r, g, b] * (size * size))


def check(name, cond):
    if cond:
        print(f"  ok  {name}")
    else:
        print(f"FAIL  {name}")
        check.failed += 1
check.failed = 0


def close(a, b, eps=0.001):
    return abs(a - b) < eps


# --- frame_luma_mean: pure per-frame math. Epsilon comparisons throughout: 0.299+0.587+0.114 is
# not exactly 1.0 in binary floating point, so an exact `==` on a derived luma value is testing
# float representation, not the function. ---
check("luma mean of a flat gray(128,128,128) frame is ~128.0",
      close(pg.frame_luma_mean(solid(128, 128, 128), SZ), 128.0))
check("luma mean of pure white is ~255.0", close(pg.frame_luma_mean(solid(255, 255, 255), SZ), 255.0))
check("luma mean of pure black is 0.0", pg.frame_luma_mean(solid(0, 0, 0), SZ) == 0.0)
# BT.601 weights: 0.299*200 + 0.587*100 + 0.114*50 = 59.8 + 58.7 + 5.7 = 124.2
check("luma mean uses BT.601 weights, not a flat average",
      close(pg.frame_luma_mean(solid(200, 100, 50), SZ), 124.2))

# --- clip_luma_mean: averages across frames, fails loud on empty ---
check("clip_luma_mean averages across frames",
      close(pg.clip_luma_mean([solid(100, 100, 100), solid(200, 200, 200)], SZ), 150.0))
try:
    pg.clip_luma_mean([], SZ)
    check("clip_luma_mean raises DecodeFailure on an empty frame list (did NOT raise)", False)
except pg.DecodeFailure:
    check("clip_luma_mean raises DecodeFailure on an empty frame list", True)

# --- ratio_verdict: the derived tolerance, both sides of the band ---
# cf#532-derived measured cases: identity 0.9926, lossless 1.0038, known-bad 0.298. None of these
# sit near the tolerance boundary, so an exact `==` on the verdict string is safe here.
check("measured identity ratio (0.9926) is OK", pg.ratio_verdict(100.0, 99.26)["verdict"] == "ok")
check("measured lossless ratio (1.0038) is OK", pg.ratio_verdict(100.0, 100.38)["verdict"] == "ok")
check("measured known-bad ratio (0.298) is WRECKED",
      pg.ratio_verdict(100.0, 29.8)["verdict"] == "wrecked")
# Comfortably inside/outside the 0.02 band rather than pinned exactly to the boundary -- 1.02
# itself is not exactly representable in binary floating point, and asserting the literal boundary
# would test float rounding rather than the tolerance logic.
check("just inside the tolerance boundary (ratio 1.015) is OK",
      pg.ratio_verdict(100.0, 101.5)["verdict"] == "ok")
check("just outside the tolerance boundary (ratio 1.025) is WRECKED",
      pg.ratio_verdict(100.0, 102.5)["verdict"] == "wrecked")
check("ratio_verdict reports the actual ratio, not just the verdict",
      pg.ratio_verdict(100.0, 50.0)["ratio"] == 0.5)
try:
    pg.ratio_verdict(0.0, 50.0)
    check("ratio_verdict raises DecodeFailure on non-positive source luma (did NOT raise)", False)
except pg.DecodeFailure:
    check("ratio_verdict raises DecodeFailure on non-positive source luma", True)
try:
    pg.ratio_verdict(-5.0, 50.0)
    check("ratio_verdict raises DecodeFailure on negative source luma (did NOT raise)", False)
except pg.DecodeFailure:
    check("ratio_verdict raises DecodeFailure on negative source luma", True)

# --- check_pair: I/O orchestration with an injected decoder (no real ffmpeg). size=SZ threaded
# through explicitly -- the synthetic frames here are SZ x SZ, not the real decoder's SAMPLE_SIZE,
# and check_pair defaults to the real SAMPLE_SIZE, so leaving this implicit reads a wrong-size
# buffer past its end rather than failing cleanly. ---
def fake_frames(good_src, good_out):
    def sample(path, size=pg.ic.SAMPLE_SIZE, count=pg.ic.SAMPLE_COUNT):
        if path == "src.mp4":
            return good_src
        if path == "out.mp4":
            return good_out
        return []
    return sample

good_pair_sampler = fake_frames([solid(100, 100, 100)] * 3, [solid(99, 99, 99)] * 3)
result = pg.check_pair("src.mp4", "out.mp4", sample_frames_fn=good_pair_sampler, size=SZ)
check("check_pair passes an identity-shaped pair through to a verdict", result["verdict"] == "ok")
check("check_pair reports src_frames/output_frames counts",
      result["src_frames"] == 3 and result["output_frames"] == 3)

wrecked_sampler = fake_frames([solid(100, 100, 100)] * 3, [solid(30, 30, 30)] * 3)
result = pg.check_pair("src.mp4", "out.mp4", sample_frames_fn=wrecked_sampler, size=SZ)
check("check_pair flags a wrecked (darkened) pair", result["verdict"] == "wrecked")

try:
    pg.check_pair("missing.mp4", "out.mp4", sample_frames_fn=good_pair_sampler, size=SZ)
    check("check_pair raises DecodeFailure when the source path decodes to zero frames (did NOT raise)", False)
except pg.DecodeFailure:
    check("check_pair raises DecodeFailure when the source path decodes to zero frames", True)

# --- check_shots: denominator reporting across multiple shot pairs ---
multi_sampler = fake_frames([solid(100, 100, 100)], [solid(99, 99, 99)])
batch = pg.check_shots([("src.mp4", "out.mp4"), ("src.mp4", "out.mp4")],
                        sample_frames_fn=multi_sampler, size=SZ)
check("check_shots reports the full denominator on an all-ok batch",
      batch["shots_checked"] == 2 and batch["shots_total"] == 2 and batch["shots_wrecked"] == 0)
check("check_shots verdict is ok when no shot is wrecked", batch["verdict"] == "ok")

def mixed_sample(path, size=pg.ic.SAMPLE_SIZE, count=pg.ic.SAMPLE_COUNT):
    if path == "src.mp4":
        return [solid(100, 100, 100)]
    if path == "out_ok.mp4":
        return [solid(99, 99, 99)]
    if path == "out_bad.mp4":
        return [solid(30, 30, 30)]
    return []

mixed_batch = pg.check_shots(
    [("src.mp4", "out_ok.mp4"), ("src.mp4", "out_bad.mp4"), ("src.mp4", "out_ok.mp4")],
    sample_frames_fn=mixed_sample, size=SZ,
)
check("check_shots counts exactly the wrecked shots, not the whole batch",
      mixed_batch["shots_wrecked"] == 1 and mixed_batch["shots_checked"] == 3)
check("check_shots verdict is wrecked when ANY shot is wrecked", mixed_batch["verdict"] == "wrecked")

# A pair that fails to decode ABORTS the batch (fail loud), and the exception carries the
# denominator reached before the failure -- not silently dropped, not counted as passed.
def fails_on_second(path, size=pg.ic.SAMPLE_SIZE, count=pg.ic.SAMPLE_COUNT):
    if path == "src.mp4":
        return [solid(100, 100, 100)]
    if path == "out_ok.mp4":
        return [solid(99, 99, 99)]
    return []  # out_missing.mp4 decodes to nothing

try:
    pg.check_shots(
        [("src.mp4", "out_ok.mp4"), ("src.mp4", "out_missing.mp4"), ("src.mp4", "out_ok.mp4")],
        sample_frames_fn=fails_on_second, size=SZ,
    )
    check("check_shots raises (does not silently skip) on an undecodable shot (did NOT raise)", False)
except pg.DecodeFailure as e:
    check("check_shots raises DecodeFailure on an undecodable shot rather than skipping it", True)
    check("the raised failure states the denominator reached before it (1 of 3)",
          "1 of 3" in str(e) and "shot 1 of 3" in str(e))

check("SEMANTIC_PRECONDITION is named identity_preserving",
      pg.SEMANTIC_PRECONDITION == "identity_preserving")
check("module docstring states the identity-preserving precondition",
      "identity-preset" in pg.__doc__ and "PRESERVE" in pg.__doc__)

if check.failed:
    print(f"\n{check.failed} FAILED")
    sys.exit(1)
print("\nall photometric_gate tests passed")
