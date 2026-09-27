### docs(flip-control): make the `data:` URI the default way to supply the flipped frame (cf#954)

The flip control needs an end frame that does not exist anywhere public: you make it locally, so the
bytes have to reach the vendor somehow. **The obvious move is to host or proxy it, and that is the
move that fails.**

Measured on `seedance-v1-5-pro-i2v`, 2026-09-27, after doing it the hard way first. Serving the flip
through `images.weserv.nl` was verified from the caller (HTTP 200, and 2.71 mean-abs-diff against the
local flip, i.e. re-encode noise only). The vendor answered:

> `Could not download the input from images.weserv.nl (HTTP 403)`

**Reachable by us, 403 to them.** That cost a render, and it cost it to the person who had already
written "the images must be reachable BY THE VENDOR" into this very file. The compliant path
(presign, or find a host the vendor will fetch) was more expensive than the convenient one, so the
convenient one got used. **A warning that costs more to obey than to ignore is not a mechanism**,
which is why this lands as a documented default rather than a sharper warning.

**The `data:` URI is a first-class accepted form, in the endpoint's own words:**

> `Input must be a public http(s) URL, a data: URI, or a base64-encoded file`

It needs no bucket, no presigning, no proxy and no public URL, and the bytes the vendor reads are
byte-identical to the ones the caller measures against, which removes re-encoding from the comparison
as well. Verified end to end: a `data:` URI flip was accepted and rendered
(`sync-492c7275-2c2c-498c-a216-f8fc4d1086a3-u2`). Size is the only real constraint, so the note gives
a worked figure: 256x144 at moderate JPEG quality is about 4KB, roughly 5.4KB base64, and the flip
should match the start frame's dimensions or the door may reject or letterbox the pair.

Also here, in `scripts/check-capability-matrix.mjs`: **when NOT to copy the cross-repo gate pattern**,
recorded because it nearly was (cp#541). That gate is correct only when the two sides are genuinely
the same set. `modules/` and the capability matrix are. The control plane's
`PUBLIC_ENDPOINT_ALLOWLIST` looked like the same shape and is not: **nine cf modules declare a literal
`ENDPOINT_ID` while `narration-gen` is catalogued and allow-listed and declares none**, so a gate
equating that allow-list with cf's module-declared slugs would be **red on a correct estate, in both
directions at once**. strummer read this file before deciding not to copy it and asserted the
allow-list against the plane's catalog instead, which is the set it actually mirrors. The header now
says to ask what the two populations ARE before reusing the shape, rather than what they look like.

Comments only; no behaviour change. Gate: `npm run typecheck` exit 0; `flip-control` and
`capability-matrix-gate-830` suites 24 passed; `check:matrix` exit 0.
