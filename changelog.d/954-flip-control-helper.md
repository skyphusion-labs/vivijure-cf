### test(flip-control): a shared end-frame control that can return every verdict, including VOID (cf#954)

`usage.first_last: true` is a DECLARATION. Five doors carry it and, measured on `main` before
cf#922 landed, **only one had been proven to honour it**. A door that accepts an end frame and
silently discards it produces a perfectly plausible clip, so nothing in the output betrays it.

This adds the instrument that does, as **one shared helper** rather than a copy per door.

**The trick:** render with an end frame that is a **horizontal flip of the start frame**. Honoured
and ignored then give different readings, because a door that discarded the end frame ends near the
START image while one that used it ends near the flipped image. Without the flip the two inputs
look alike and both verdicts produce identical numbers.

**It carries its own control of the control.** `startVsEnd` is the discriminator's discriminator:
if the two INPUT images barely differ, no reading of the output can separate the verdicts, and the
answer is **VOID** rather than a confident "honoured". `endFrameReport` surfaces
`controlSeparation` and `controlOk` so a caller asserts on the numbers rather than on a boolean,
because a helper that hides the control line lets a near-identical input pair report a confident
nothing.

`tests/flip-control.test.ts` asserts **all four verdicts are reachable** (honoured, ignored, void,
ambiguous) before any door is judged. **A flip control that can only report "honoured" is worth
less than no control at all**, and this repo has now fixed two instruments with that shape in one
day (cf#951's census, and a resolution check that could not distinguish a live knob from an inert
one defaulting to the same value).

Calibration reading baked into the test, from the one door proven to honour an end frame:

```
inputs differ by 62.25    (near-zero here voids the test)
FIRST frame  vs start  2.01   vs end 62.89  -> START
LAST  frame  vs start 62.63   vs end  3.75  -> END       verdict: honoured
```

Carries two field notes measured by joan on `seedance-v1-5-pro-i2v` the same day, because both
change how a caller must use it: **the images must be reachable BY THE VENDOR** (a Wikimedia thumb
URL 400s where a resolved direct URL works), and **RunPod public endpoints do NO submit-time
envelope validation** -- `{"input": {}}` is accepted, starts a worker and fails after ~47s, and
unknown keys are silently ignored. So a malformed probe is not free, and **the absence of a schema
error proves nothing about whether a key was read**.

No module or `src/` change. Helper plus its own tests only; no door consumes it yet.

Gate: `npm run typecheck` exit 0; `npm test` exit 0; `npm run guard:resolve`, `npm run
check:catalog`, `npm run check:matrix` exit 0.
