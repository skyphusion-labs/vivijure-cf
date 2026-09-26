### fix(modules): excise MuseTalk -- remove finish-lipsync, its deploy gate and its demo seed

MuseTalk is ruled out permanently as a lip-sync provider and its RunPod endpoint no longer
exists, so the `finish-lipsync` module that clients it is gone, along with the `MODULE_LIPSYNC`
binding, the `MUSETALK_RUNPOD_ENDPOINT_ID` secret, the `--satellite lipsync` provisioner and the
hosted strip script whose only job was removing the block. `deploy.sh --satellites` no longer
dies without a MuseTalk endpoint id, the planner no longer offers "Replace mouths with MuseTalk",
and a new demo migration drops the row from the PUBLIC demo catalog.

Lip-sync itself is unchanged: `infinitetalk` is the live audio-driven door and drives motion FROM
the Cast audio, so the mouth is right at animation time instead of patched afterwards. On a silent
motion door a spoken line is now the Cast voice MUXED, with the mouth left as the model animated
it, and the door blurbs say so rather than promising a sync they cannot deliver.

Two consequences recorded rather than papered over: no shipped module declares
`finish_consumes_audio` any more (the core mechanism is untouched), and `speech-upscale` has lost
its only planner trigger, asserted as a negative test so the hole is visible.
