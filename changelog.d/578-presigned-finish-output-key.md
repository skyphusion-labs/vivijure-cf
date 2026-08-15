### fix(finish): accept the presigned satellite return shape, and degrade instead of failing (cf#578)

In presigned mode the finish satellites return the written key as `output_key` and no `clip_key`,
and `finish-upscale` and `finish-lipsync` both treated that as a hard failure. The job burned the
GPU, PUT the artifact, and then died on the response parse. Because it came back `ok:false` it
routed to the chain failure path rather than the degrade path, which fails the whole film and leaves
no countable record of what happened.

Both poll sites now resolve the written key through `finishedKey`, which reads whichever field the
satellite used, and both soft-degrade on a genuinely empty result the way `speech-upscale` already
did. `finish-upscale` also carries the input clip in its poll token now, which is what it was
missing to be able to make that same decision.

Second, smaller loss found on the way: vivijure-upscale sends no `applied` array on its presigned
branch while sending one on the R2 branch, so mapping only the key name would have dropped the
provenance tag on every presigned render. The tag is now derived from the `scale` the endpoint
itself reports, never from the config we asked for.

Scope is 2 of the 5 finish-class doors, not the 4 that hard-fail on a missing `clip_key`:
`finish-rife` talks to a backend with no presigned branch at all, and `finish-blender` talks to a
satellite that emits `clip_key` in both modes. Neither can produce the shape.
