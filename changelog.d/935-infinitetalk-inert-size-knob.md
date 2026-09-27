### fix(infinitetalk)!: remove the size knob the vendor ignores (cf#935)

`infinitetalk` advertised a `size` choice of `480p` or `720p`. The provider ignores it: both values
deliver **832x464**. The knob is removed from `config_schema` rather than defaulted, a `ui.limits` entry
states the real output so the removal is not a silent loss, and the reason sits at the call site in
`kling.ts` so it is not re-added from the vendor docs later.

Measured three ways across two independent paths -- a full film, a clips-door render with
`size: "720p"`, and a **direct submit to RunPod that bypassed this worker, core, `validateConfig` and
the invoke transport entirely** (job `d159bf34-3f84-41fa-a472-1d3875178638-u1`). All three returned
832x464, dimensions read off the artifact rather than a response field. Our pipeline is exonerated: the
value reaches the vendor and the vendor discards it.

This had a money edge. RunPod publishes InfiniteTalk at **$0.25 (480p) and $0.50 (720p)**, so a user
selecting 720p could pay double for byte-identical pixels. Whether RunPod bills on the requested or the
delivered size is **unmeasured and currently unmeasurable** -- their billing API has read $0.00 for all
of September while renders demonstrably ran (`vivijure-control-plane#525`) -- so no figure is asserted
here.

RunPod's own documentation still lists `input.size` as required with both values valid, and prices each
tier. The parameter is documented, priced, accepted, and inert; reporting that upstream is a separate
decision.

An existing test expected `size: "720p"` back and passed. It was not measuring the vendor, it was
measuring our own ternary echoing the caller -- a green test confirming a knob that never worked.
Corrected in place rather than deleted, so the wrong expectation stays visible in history.

**BREAKING**: `size` is removed from `infinitetalk`'s `config_schema` (module `0.1.1` -> `0.2.0`). A
caller still passing it is unaffected in behaviour, since 480p was always what the vendor produced.
