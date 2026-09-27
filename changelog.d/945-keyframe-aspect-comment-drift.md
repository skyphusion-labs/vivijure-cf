### docs(keyframe): 1344x768 is 1.75, not 16:9 -- correct four comments that asserted the wrong ratio (cf#945)

Comment and README text only. **No behaviour change, no default changed.**

`modules/keyframe`, `modules/cloud-keyframe` and `modules/local-gpu` all default the keyframe to
**1344x768**, and four places described that as "16:9":

- `modules/keyframe/src/manifest.ts` (block comment above the default, said 16:9 four times)
- `modules/cloud-keyframe/src/index.ts` (block comment above the default, three times)
- `modules/keyframe/README.md` (config table: "16:9 so the whole chain stays 16:9")
- `modules/cloud-keyframe/README.md` (same table row)

**1344 / 768 = 1.75 (7:4). 16:9 is 1.7778.** 16:9 at width 1344 would be height **756**. Each comment
was otherwise accurate, which is what made it durable: 1344x768 really is a standard SDXL bucket, and
"image-to-video backends conform the clip to the keyframe's aspect ratio" is exactly right and was
confirmed by render this sprint. One wrong token sat inside two true sentences, on the line a reader
checks to confirm the ratio, so every downstream assumption that clips arrive 16:9 traced back to a
line that said so.

Measured consequence (vivijure#826, three live `alibaba/wan-2.7-i2v` renders): i2v doors preserve the
caller's aspect ratio and fill the requested class's pixel budget, so a 1.75 keyframe yields 1270x726
at 720P and 1904x1088 at 1080P, and `containers/video-finish`'s fixed 1920x1080 target must then
pillarbox them (content box 1890x1080, black bars 14px left / 16px right, baked in at crf 18). A 16:9
keyframe yields exactly 1280x720, which scales to 1920x1080 with no bars at all.

Each corrected comment now states the ratio **numerically** rather than by label, so the next reader
gets a number to check instead of a word to trust, and points at cf#945 for the residual mismatch.

**Deliberately NOT changed here**, and tracked on cf#945:

- The `1344`/`768` defaults themselves. 16:9 is unreachable at height 768 (768 x 16/9 = 1365.33), so
  the candidates are 1280x720 or 1920x1080, and whether SDXL keyframe quality holds at either is
  unmeasured. That measurement is the content of that change, not the arithmetic.
- `modules/local-gpu/src/manifest.ts` carries the same defaults with no comment, so it had no wrong
  token to correct. It is named on cf#945 so the three do not drift apart when the defaults move.
- `nearestAspectRatio(1344, 768) === "16:9"` in `modules/cloud-keyframe/src/image-gen.ts` is correct
  and intentional: it snaps to the nearest ratio a proxied model accepts so the provider *composes*
  for that shape, and `normalizeKeyframe` then crops to the exact configured dimensions. Its test
  comment already reads "1.75 -> nearest 16:9", which is honest about the snap.

Gate: `npm run typecheck` exit 0; `npm test` exit 0; `npm run guard:resolve`, `npm run check:catalog`,
`npm run check:matrix` exit 0.
