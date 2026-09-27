### fix(modules): measure fps and frames from the delivered artifact, not the request (cf#923)

Both talking doors declared `OUT_FPS = 24` and **neither delivered it**. `infinitetalk` returns 25,
`alibaba-wan` returns 30. The constant had never been compared to a real file.

Two shapes of the same bug. `infinitetalk` was half-measured: real container duration, multiplied by an
assumed rate. `alibaba-wan` never opened the artifact at all, reporting `frames: st.seconds * 24` -- the
**requested** seconds times an assumed rate -- so a 5s clip reported 120 frames against an actual 150,
with the error scaling linearly (a 15s clip would report 360 against 450).

The rule, since it generalises past these two fields: **a value computed from the request is not a
measurement, no matter what the field is named.**

Both doors now read the MP4 sample table. `frames` is the sum of `stts` sample counts, which *is* the
frame count rather than an estimate; `fps` is that count over the track duration in the `mdhd`
timescale. The video track is identified by its `hdlr` handler type, so an audio track cannot be
mistaken for it.

**Unmeasured is reported as `0/0`, never as a constant** -- and that is the contract's existing
not-available channel rather than a new invention. Conformance checks `isNum(o.fps)`, not `> 0`, and
core records a delivery only when `fps > 0 && frames > 0`. So an unparseable container costs a telemetry
field and never a render: the clip still ships, and nothing downstream stores a rate nobody measured.

The parser lives in `modules/_shared/mp4-timing.ts` rather than being vendored into each door, a
deliberate departure from the per-module vendoring convention: **the defect WAS a vendored copy**, one
constant pasted into two modules where nobody re-checked it. A copied helper forks at copy time and
inherits the assumption without inheriting the check. A test asserts both doors return identical values
for identical bytes, as the guard against the copy returning.

Fixtures are real libx264-muxed containers at 25 and 30fps, not hand-built byte arrays, because a
hand-built fixture encodes the same assumptions the parser makes and cannot falsify it. The parser was
first validated against three real delivered clips and agrees with `ffprobe` exactly: 25fps/73 frames
twice, 30fps/150 frames once.

An existing assertion expected 72 frames and passed. It measured nothing -- 72 is 3s times an assumed
24. Corrected in place, and it now pins the unmeasured case, since that fixture is an `mvhd`-only stub
with no video track.

No module version bumps here: cf#935 and cf#929 bump `infinitetalk` to `0.2.0` and `alibaba-wan` to
`0.2.1` in the same unreleased cycle, and a second bump per module would be noise.
