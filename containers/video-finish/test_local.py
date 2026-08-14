"""Real-ffmpeg proof for photometric_gate (cf#532) -- drives the gate against ACTUALLY DECODED
frames, not synthetic bytes: a real lossy h264 round trip (the "encode-loss" arm, GREEN) and a real
darkened clip standing in for vivijure-blender#14's defect (the "wrecked" arm, RED). Mirrors
containers/audio-master/test_local.py and containers/audio-mix/test_local.py: needs ffmpeg/ffprobe
on PATH, no R2, no network. NOT run in container-tests CI -- ffmpeg presence on that runner is not
yet established by effect (see ci.yml's own comment on this, next to test_local.py's siblings not
being wired in either); this file exists to be run and read as evidence, same as they do.

    python3 test_local.py

Exits non-zero on any failed assertion, and prints the actual measured ratios either way -- the
numbers are the point, not just the pass/fail bit.
"""
import os
import subprocess
import sys
import tempfile

import photometric_gate as pg


def _run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def main():
    failures = []
    work = tempfile.mkdtemp(prefix="pgate-test-")

    # Source: a real decodable clip with non-trivial, non-uniform luma (testsrc's colour bars/
    # gradient), not a flat colour -- a flat source can't distinguish "encode changed the picture"
    # from "encode changed nothing", because a solid colour survives most encoders untouched.
    src = os.path.join(work, "src.mp4")
    _run(["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=1",
          "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", src])

    # ARM 1, GREEN: a real lossy round trip with NO grading applied -- decode-recompress only, the
    # same shape of loss cf#532's derivation measured (0.9926) on the deployed door. If this arm
    # does not land inside the band, the tolerance is too tight for real encode loss and the gate
    # would false-positive on every correct render.
    identity = os.path.join(work, "identity.mp4")
    _run(["ffmpeg", "-y", "-i", src, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", identity])
    identity_result = pg.check_pair(src, identity)
    print(f"[identity round trip] ratio={identity_result['ratio']} "
          f"src_luma={identity_result['src_luma']} output_luma={identity_result['output_luma']} "
          f"frames sampled: src={identity_result['src_frames']} output={identity_result['output_frames']} "
          f"verdict={identity_result['verdict']}")
    if identity_result["verdict"] == "ok":
        print("[PASS] a real lossy re-encode with no grading lands inside the tolerance band")
    else:
        failures.append(
            f"identity round trip WRONGLY flagged wrecked at ratio {identity_result['ratio']} -- "
            f"the tolerance is too tight for real encode loss"
        )

    # ARM 2, RED: a real darkening filter standing in for vivijure-blender#14's defect (frames
    # 3.3x darker with a colour cast). eq=brightness=-0.4 is a real ffmpeg filter, not a synthetic
    # number -- this drives the gate against actually-decoded wrecked pixels.
    wrecked = os.path.join(work, "wrecked.mp4")
    _run(["ffmpeg", "-y", "-i", src, "-vf", "eq=brightness=-0.4",
          "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", wrecked])
    wrecked_result = pg.check_pair(src, wrecked)
    print(f"[wrecked (darkened)] ratio={wrecked_result['ratio']} "
          f"src_luma={wrecked_result['src_luma']} output_luma={wrecked_result['output_luma']} "
          f"frames sampled: src={wrecked_result['src_frames']} output={wrecked_result['output_frames']} "
          f"verdict={wrecked_result['verdict']}")
    if wrecked_result["verdict"] == "wrecked":
        print(f"[PASS] a real darkened clip is flagged wrecked "
              f"(ratio {wrecked_result['ratio']}, outside +/-{pg.RATIO_TOLERANCE} of 1.0)")
    else:
        failures.append(
            f"wrecked (darkened) clip was NOT flagged -- ratio {wrecked_result['ratio']} read as ok, "
            f"the gate would have missed vivijure-blender#14's own defect shape"
        )

    # SEPARATION: the wrecked ratio must fall outside the band by a real margin, not merely fail --
    # this is the discrimination the dispatch asked to see, not just two pass/fail bits.
    margin = abs(1.0 - wrecked_result["ratio"]) / pg.RATIO_TOLERANCE
    print(f"[margin] wrecked case is {margin:.1f}x outside the tolerance band "
          f"(cf#532's own measured known-bad case was 15x outside)")
    if margin < 2.0:
        failures.append(
            f"wrecked arm only {margin:.1f}x outside the band -- too close to be a convincing "
            f"discrimination proof, even though it technically failed"
        )

    # COULD-NOT-DECODE fails loud rather than skips.
    try:
        pg.check_pair(src, os.path.join(work, "does-not-exist.mp4"))
        failures.append("check_pair did NOT raise on an undecodable output path")
    except pg.DecodeFailure:
        print("[PASS] an undecodable clip raises DecodeFailure rather than passing or skipping")

    if failures:
        print(f"\n{len(failures)} FAILED:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\nall photometric_gate real-ffmpeg checks passed")


if __name__ == "__main__":
    main()
