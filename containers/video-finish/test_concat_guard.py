"""Arithmetic proof for concat_guard (cf#784) -- stdlib only, no ffmpeg, no network.

Runs in container-tests CI, which is the point: the guard this replaces lived inside
`_assemble` behind a real ffmpeg call, so its logic had never been asserted anywhere.
Pulling the arithmetic into a pure function is what makes it gateable on a runner with
no encoder.

    python3 test_concat_guard.py

Exits non-zero on any failed assertion. Prints the measured numbers either way: the
ratios are the evidence, not the pass/fail bit.

The real-encoder proof (truncate an actual partial, watch a real ffmpeg concat get
caught) is test_local_concat_guard.py, which needs ffmpeg on PATH and is NOT run here,
for the same runner reason ci.yml gives for test_local.py.
"""
import sys

import concat_guard as cg


def main():
    failures = []
    checks = 0

    def ok(cond, label, detail=""):
        nonlocal checks
        checks += 1
        if cond:
            print("[PASS] %s %s" % (label, detail))
        else:
            failures.append("%s %s" % (label, detail))
            print("[FAIL] %s %s" % (label, detail))

    # ---------------------------------------------------------------- ARM 1, GREEN
    # Inverse control. A CORRECT hard concat must not trip the guard, or every honest
    # render fails and the guard is worse than useless.
    parts = [2.0] * 8
    expected, slack = cg.assert_no_dropped_parts(16.0, parts, level="green/hard", fps=24)
    ok(abs(expected - 16.0) < 1e-9, "correct hard concat passes,", "expected=%.3f slack=%.4f" % (expected, slack))

    # Frame-scale rounding must also pass: real containers do not land on exact sums.
    cg.assert_no_dropped_parts(16.0 - (1.0 / 24), parts, level="green/rounding", fps=24)
    ok(True, "one frame of container rounding passes,", "16.000 -> %.4f" % (16.0 - 1.0 / 24))

    # ---------------------------------------------------------------- ARM 2, RED
    # The defect. One whole part dropped, at counts where the OLD 0.85 ratio went blind.
    for n in (7, 8, 10, 40):
        full = [2.0] * n
        dropped_total = 2.0 * (n - 1)
        old_ratio_fires = dropped_total < (2.0 * n) * 0.85
        try:
            cg.assert_no_dropped_parts(dropped_total, full, level="red/%d parts" % n, fps=24)
            caught = False
        except cg.ConcatDropError:
            caught = True
        ok(caught,
           "dropped 1 of %-2d parts CAUGHT;" % n,
           "ratio=%.4f, old 0.85 guard would fire=%s" % (dropped_total / (2.0 * n), old_ratio_fires))
        # The regression this module exists for: prove the OLD guard really was blind
        # here, so the new one is not just re-passing a test the old one also passed.
        if n >= 7:
            ok(not old_ratio_fires,
               "and the OLD ratio guard was BLIND at %d parts," % n,
               "%.4f >= 0.85" % (dropped_total / (2.0 * n)))

    # Smallest droppable part (the 0.1s floor `_assemble` enforces) must still be seen.
    base = [2.0] * 5
    try:
        cg.assert_no_dropped_parts(sum(base), base + [cg.MIN_PART_SECONDS], level="red/min part", fps=24)
        caught = False
    except cg.ConcatDropError:
        caught = True
    ok(caught, "a dropped 0.1s minimum-length part is CAUGHT,", "tolerance must stay under the floor")

    # ---------------------------------------------------------- ARM 3, CROSSFADE
    # Crossfade legitimately shortens the film. That is the ONLY reason the old guard
    # needed slop, and accounting for it explicitly is what lets the tolerance be tight.
    n, dur, xf = 6, 3.0, 0.5
    faded = cg.expected_concat_seconds([dur] * n, crossfade=xf)
    want = dur * n - (n - 1) * xf
    ok(abs(faded - want) < 1e-9, "crossfade expectation is exact,", "%.3f == %.3f" % (faded, want))
    cg.assert_no_dropped_parts(want, [dur] * n, level="green/crossfade", crossfade=xf, fps=24)
    ok(True, "a correct crossfade concat passes,", "no false positive from the overlap")
    # ...and a drop is still caught THROUGH the crossfade accounting.
    try:
        cg.assert_no_dropped_parts(want - dur, [dur] * n, level="red/crossfade", crossfade=xf, fps=24)
        caught = False
    except cg.ConcatDropError:
        caught = True
    ok(caught, "a drop is caught even with crossfade slack applied,", "")
    # The clamp must mirror _concat_crossfade, or the two silently disagree.
    ok(cg.clamped_crossfade(9.9) == cg.CROSSFADE_MAX, "crossfade clamps high to 1.5,", "")
    ok(cg.clamped_crossfade(0.01) == cg.CROSSFADE_MIN, "crossfade clamps low to 0.1,", "")
    ok(cg.clamped_crossfade(0.0) == 0.0, "zero crossfade stays zero,", "hard-cut path")

    # ------------------------------------------------- ARM 4, THE GUARD'S OWN GUARD
    # A tolerance wider than the smallest part would re-open the blindness silently.
    # It must refuse to run rather than pass vacuously.
    try:
        cg.assert_tolerance_is_sound(fps=24, tolerance_frames=100)
        refused = False
    except ValueError:
        refused = True
    ok(refused, "an unsound (too wide) tolerance is REFUSED,", "not silently accepted")
    try:
        cg.assert_tolerance_is_sound(fps=1, tolerance_frames=2)
        refused = False
    except ValueError:
        refused = True
    ok(refused, "a low fps that inflates the slack is REFUSED,", "2 frames at 1fps = 2s > 0.1s floor")
    ok(cg.assert_tolerance_is_sound(fps=24) < cg.MIN_PART_SECONDS,
       "the default tolerance is sound at 24fps,", "%.4fs < %.4fs" % (cg.tolerance_seconds(24), cg.MIN_PART_SECONDS))

    # Empty / degenerate input must not raise: no parts means nothing to compare.
    e, s = cg.assert_no_dropped_parts(0.0, [], level="degenerate", fps=24)
    ok(e == 0.0 and s == 0.0, "empty part list is a no-op,", "not a false positive")

    print("\n%d checks, %d failures" % (checks, len(failures)))
    if failures:
        for f in failures:
            print("  FAILED: %s" % f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
