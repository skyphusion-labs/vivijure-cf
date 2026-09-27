"""Drop detection for ffmpeg concat, at BOTH levels of a chunked assemble (cf#784).

WHY THIS IS NOT A RATIO

The original guard (app.py, pre-#784) was:

    if _sum_in > 0 and _sil < _sum_in * 0.85: raise

A flat 15 percent tolerance. That works for a handful of clips and silently stops
working as the count grows, because dropping ONE of N parts leaves (N-1)/N of the
duration behind:

    6 parts -> 0.8333 -> caught
    7 parts -> 0.8571 -> MISSED
    10 parts -> 0.9000 -> MISSED

So the guard gets blinder exactly as the film gets longer, which is the wrong
direction for a check whose whole purpose is "a scatter render once shipped 1 of 3
shots". Chunked assemble makes this acute: it introduces a SECOND concat level whose
parts are whole batches, and `MAX_CLIPS` is 80, so 7+ parts at the outer level is the
normal case rather than the edge one. Ported unchanged, the outer guard would be
decoration -- present, green, and structurally unable to see the failure it is named
for.

The fix is to stop guessing a tolerance and compute what the duration SHOULD be:

  * hard concat (`-c copy`): the parts are laid end to end, so expected == sum.
  * crossfade concat: each join overlaps by the clamped crossfade, so
    expected == sum - (n-1) * xf. `_concat_crossfade` clamps xf to [0.1, 1.5];
    this mirrors that clamp rather than re-deriving it, so the two cannot drift.

That removes the reason the tolerance had to be loose. What remains is real but
small: container duration rounding and frame quantisation, which are frame-scale,
not 15-percent scale. The tolerance is therefore expressed IN FRAMES.

The tolerance must stay below the smallest droppable part or the guard goes blind
again. `_assemble` floors every normalized clip at 0.1s (`cap = max(0.1, ...)`), so
the default of 2 frames (0.083s at 24fps) sits under that floor. `assert_tolerance_is_sound`
makes that relationship a checked precondition instead of a comment, because it is the
one number whose drift would silently disarm everything here.

Stdlib only, no ffmpeg, no I/O: every input is a duration in seconds that the caller
has already probed. That is deliberate -- it means the arithmetic can be gated in CI
on a runner with no ffmpeg, which is where the old guard's logic was never tested.
"""

CROSSFADE_MIN = 0.1
CROSSFADE_MAX = 1.5

#: Smallest duration `_assemble` will emit for a normalized clip (`max(0.1, ...)`).
MIN_PART_SECONDS = 0.1

#: Frames of slack allowed between expected and assembled duration.
DEFAULT_TOLERANCE_FRAMES = 2.0


class ConcatDropError(RuntimeError):
    """A concat produced materially less footage than its inputs: a part was dropped."""


def clamped_crossfade(crossfade):
    """The crossfade `_concat_crossfade` will actually apply, including its clamp."""
    if not crossfade or crossfade <= 0:
        return 0.0
    return max(CROSSFADE_MIN, min(float(crossfade), CROSSFADE_MAX))


def expected_concat_seconds(part_durations, crossfade=0.0):
    """Duration a correct concat of these parts must produce.

    Hard concat lays parts end to end. Crossfade overlaps each of the (n-1) joins by
    the clamped crossfade, so the film is shorter by exactly that much.
    """
    parts = [float(d) for d in part_durations if d and float(d) > 0]
    if not parts:
        return 0.0
    total = sum(parts)
    xf = clamped_crossfade(crossfade)
    if xf > 0 and len(parts) > 1:
        total -= (len(parts) - 1) * xf
    return max(0.0, total)


def tolerance_seconds(fps, tolerance_frames=DEFAULT_TOLERANCE_FRAMES):
    """Allowed shortfall, in seconds. Frame-scale, never a percentage."""
    return float(tolerance_frames) / max(1.0, float(fps))


def assert_tolerance_is_sound(fps, tolerance_frames=DEFAULT_TOLERANCE_FRAMES,
                              min_part_seconds=MIN_PART_SECONDS):
    """Fail loudly if the tolerance could swallow a whole dropped part.

    A guard whose slack exceeds the smallest thing it is meant to detect cannot
    detect it. This is the precondition that keeps the tolerance honest as fps or
    the frame budget change; without it, raising either number would silently
    re-open the blindness this module exists to close.
    """
    slack = tolerance_seconds(fps, tolerance_frames)
    if slack >= min_part_seconds:
        raise ValueError(
            "concat guard tolerance %.4fs (%.1f frames at %.3f fps) is >= the smallest "
            "droppable part %.4fs; the guard could not see a dropped part"
            % (slack, tolerance_frames, fps, min_part_seconds)
        )
    return slack


def assert_no_dropped_parts(assembled_seconds, part_durations, level,
                            crossfade=0.0, fps=24,
                            tolerance_frames=DEFAULT_TOLERANCE_FRAMES):
    """Raise ConcatDropError if `assembled_seconds` is short of what the parts imply.

    `level` names WHICH concat is being checked ("batch 3/10", "final join of
    partials") so a failure says where footage vanished; with two concat levels,
    "concat dropped clips" alone no longer identifies the site.

    Returns (expected, slack) so a caller can log the numbers on the success path
    too. A guard that only speaks when it fails gives no evidence it ran.
    """
    expected = expected_concat_seconds(part_durations, crossfade=crossfade)
    if expected <= 0:
        return 0.0, 0.0
    slack = assert_tolerance_is_sound(fps, tolerance_frames)
    assembled = float(assembled_seconds or 0.0)
    if assembled < expected - slack:
        n = len([d for d in part_durations if d and float(d) > 0])
        raise ConcatDropError(
            "concat dropped footage at %s: assembled %.3fs, expected %.3fs from %d parts "
            "(shortfall %.3fs, tolerance %.3fs)"
            % (level, assembled, expected, n, expected - assembled, slack)
        )
    return expected, slack
