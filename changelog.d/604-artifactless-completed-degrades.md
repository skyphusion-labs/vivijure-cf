### fix(finish): a COMPLETED job with no artifact key degrades in all 5 finish doors, not 3 (cf#604)

`finish-rife` and `finish-blender` returned module `ok:false` when a COMPLETED RunPod job carried no
artifact key. `ok:false` is safe at the DOOR layer and fatal at the MODULE layer: the core's
`failOrRetry` classifies it deterministic and FAILS THE FILM on a render that ran to completion and
was billed. It also never reaches `applyFinishOutput`, so the class was uncountable by construction
rather than merely uncounted. `finish-lipsync`, `finish-upscale` and `speech-upscale` have passed the
source clip through at that site since cf#578; these two were the doors that sweep did not reach.

Both now take the identical branch, with the identical `passthrough:no-output-key` tag so one grep
across the five doors finds the whole class. Derived from source and classified comment-versus-code:
3 of 5 before, 5 of 5 after.

BEHAVIOUR CHANGE: two modules that previously failed the film on an artifact-less COMPLETED job now
degrade one shot, tagged `passthrough:no-output-key` with the reason in `degraded`. A poll token
carrying no source clip still fails loud, unchanged: there is nothing honest to pass through, and
returning `ok:true` with an empty `clip_key` would be the silent-degrade shape of #77 wearing a
success. A genuine crash, which leaves no structured output, is untouched and still fails loud.

NOT DONE, and refused on measurement rather than deferred: cf#604 also asked for the cf#578 read,
`clip_key ?? output_key`. Neither door can emit that shape. Re-measured 2026-08-15 on trees
byte-identical to the shas the cf#578 census recorded: `vivijure-blender` at 4fa33fe returns
`clip_key` on every success (`handler.py:389`, `:397`) and never `output_key` as a response field;
`vivijure-backend` at f9dc930 has exactly one completed `finish_clip` return (`harness/handler.py`
`:471-476`) which hardcodes `clip_key`, and `docs/contract.md:249-268` argues the exclusion of
presigned transport deliberately. Widening the read would be changing code on a hypothesis, which is
what the cf#578 EXEMPT census declined to do; that census is untouched here and still passes.

The degrade covers the same ground more honestly anyway: if either door ever does emit a key this
module cannot resolve, the film degrades one countable shot instead of dying, which is asserted as a
test case rather than promised.
