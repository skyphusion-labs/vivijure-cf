### fix(finish): one shared poll-path soft-degrade contract, so a door degrade stops destroying films (cf#594)

The poll-path backend soft-degrade contract existed in 1 of the 4 `finish` modules. A door that could
not polish a clip but had not crashed returned a structured `{"ok": false, ...}`; `finish-lipsync`
passed the original clip through, and `finish-upscale`, `finish-rife` and `finish-blender` fell
through to the artifact parse, found no key, returned module `ok:false`, and had the core's
`failOrRetry` classify it deterministic and FAIL THE RENDER. The same honest door return was a
one-shot degrade through one module and a destroyed film through three, and a door author could not
know which they had without reading the module they sit behind.

`modules/_shared/finish-soft-degrade.ts` is now the one implementation, with four callers. Both door
shapes are recovered: `{"ok":false,"detail":...}` arrives COMPLETED, and `{"ok":false,"error":...}`
is lifted by RunPod into a FAILED envelope (cf#565). A genuine crash leaves no structured `output`
and still fails loud; that discriminator is the safety property and it did not widen.

BEHAVIOUR CHANGE: three modules that previously failed the film on a door soft-degrade now degrade
one shot, tagged `passthrough:backend-soft-degrade` with the reason in `degraded`.

The recovered FAILED envelope also records `outcome: "completed"` rather than `"failed"`. RunPod's
FAILED there is an artifact of it lifting a top-level `error` key out of a handler RETURN, not an
endpoint failure, so `failed` was wrong about the ENDPOINT and inflated the backend failure rate with
successful degrades. This does not relax cf#279: the row is still the endpoint's outcome, still
written before the output is parsed for our own use.

`finish-rife` and `finish-blender` now carry the source `clipKey` in their poll tokens, as
`finish-lipsync` always has and `finish-upscale` has since cf#578, since the passthrough IS the
original clip. A token minted before this change keeps the pre-change terminal path.

Also fixed in passing: `finish-lipsync`'s `decodePoll` resolves a token with no `clipKey` to the
empty string, so a degrade on such a token built a passthrough with an EMPTY `clip_key` and returned
`ok:true`. It now takes the same null-on-no-clip guard its `finish-upscale` sibling already had.
