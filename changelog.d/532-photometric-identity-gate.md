### feat(video-finish): a pixel-decode identity gate that catches a well-formed WRONG picture (cf#532)

No gate anywhere in the estate decoded a pixel. vivijure-blender#14 shipped a grade that darkened
frames 3.3x with a colour cast, on a preset that is a mathematical identity -- and every check
passed: correct frame count, valid mp4 structure, `degraded: 0`, and #523's own noise heuristic
(keyframe cross-correlation is scale/offset-invariant, so a uniform darkening never moved it). A
structurally-valid clip and a correct clip were the same fact to everything the estate owned.

Adds `containers/video-finish/photometric_gate.py`: decodes a source frame and its finished-clip
counterpart, computes each side's mean luma, and asserts the ratio against a tolerance derived from
measurement rather than guessed (cf#532 issue comment 5294980863) -- an identity-preset render
through this container's decode/composite/encode path measures 0.9926, a lossless round trip
measures 1.0038, the known-bad pre-fix case measures 0.298 (fifteen times outside a 0.02 band).
Fails loud (`DecodeFailure`) on could-not-decode rather than skipping: an unread frame is not a
passing frame. `check_shots` reports a denominator (shots checked / total / wrecked) rather than a
single pass/fail bit.

Exposed over HTTP as `POST /photometric-check` (`srcUrl` + `outputUrl`, presigned GET, read-only),
mirroring `/inspect`'s shape. `test_photometric_gate.py` (stdlib only, wired into `container-tests`
CI) proves the ratio math against an injected decoder; `test_local.py` (real ffmpeg, matching the
audio containers' existing not-run-in-CI pattern) drives the gate against ACTUALLY decoded frames --
a real lossy h264 round trip lands at ratio 1.0001 (inside the band), a real darkened clip lands at
ratio 0.4821 (26x outside it) -- so the band is shown to discriminate on live decode, not merely to
exist as a constant.

**Not wired into any render automatically.** `video-finish` receives only already-graded per-shot
clips for concat/mux, never the pre-grade source, so nothing can invoke this unattended today.
Deciding which layer calls it (the finish module, a post-render panel check, a canary sampler), on
every render or a canary, and threading a source-clip reference to wherever that call happens, is
explicitly out of scope here and needs its own follow-up issue.
