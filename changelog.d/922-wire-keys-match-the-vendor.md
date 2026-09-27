### fix(modules)!: send the keys the vendors actually read, and the values they actually accept (cf#922)

Two RunPod motion doors sent parameter names the endpoint does not define. Both are fixed, and the
vendor's behaviour is now MEASURED rather than assumed.

- **`seedance`** sent `last_frame_image`; the endpoint reads **`last_image`**. The wrong name is the
  Cloudflare bytedance door's key (`modules/cf-seedance`, where it is still correct) carried across.
  `seedance-v1-5-pro-i2v` is the only endpoint in RunPod's public catalog that accepts an ending frame
  at all, and this door's manifest declares `usage.first_last: true`, so the end frame meant to hold
  the cut was riding on a key the endpoint ignores.
- **`alibaba-wan`** sent `resolution: "720p"`; the endpoint reads **`size`**.

**What the vendor actually does with an unknown key: IGNORES it. Measured, not inferred.** RunPod's
public endpoints do no submit-time validation of the envelope; the worker validates with a pydantic
model that does not forbid extra fields. A body carrying the unknown key `resolution` plus a bad
`duration` came back with ONLY the duration complaint, from the upstream vendor, never a word about
`resolution`. So our value was silently dropped and the vendor applied its own default. **That is why
the 1270x726 clip measured last sprint looked correct: it was the vendor default and never a
configured outcome.**

The decisive pair is on `seedance`, identical garbage value on each key:

| submitted | result |
| --- | --- |
| `last_image: "notaurl"` | **FAILED**, `Input must be a public http(s) URL, a data: URI, or a base64-encoded file` |
| `last_frame_image: "notaurl"` | **COMPLETED** normally, $0.096 |

The live key validates the value; the retired key was not looked at. Both outcomes producible, which
is what makes this a reading rather than a guess.

**RUNPOD'S DOCS ARE WRONG ABOUT THE `size` VALUE FORMAT, and the schema-conformant fix would have
broken every wan shot.** The docs page says `size` takes `1280*720` / `1920*1080`. It does not. The
worker forwards our value verbatim into the VENDOR's `resolution` field, and `size: "9999*9999"`
returns the vendor's own enum: `field "resolution" must be one of ["720p", "1080p"]`. So this door now
sends `720p` / `1080p`. Had this landed on the documented value, a silent wrong default would have
become a hard 400 on every shot, which is the exact failure the seedance 1080p incident already cost
us a film to learn.

**The `size` knob is EARNED, which is the cf#935 test.** Rollins removed the infinitetalk `size` knob
days ago for being inert at the vendor while RunPod billed 720p at double 480p. So this one is not
added on the strength of a corrected key: `size: "1080p"` was submitted and the DELIVERED artifact
measured **1920x1080 at 30fps** with `ffprobe`. A non-default delivery is the falsifiable positive, so
this knob demonstrably moves pixels. It projects into a select automatically through the generic
render path, no frontend wiring. **720p stays the default because 1080p bills $0.15/s against
$0.10/s.** The published 1080p tier was unreachable before this, and the cause was our key, not the
vendor.

**Tests.** `tests/seedance.test.ts` asserted the same wrong key the module sent, so the suite was green
while the wire was wrong; it now asserts `last_image` AND that `last_frame_image` is never present.
Watched red first: `expected undefined to be 'https://r2/end.png'`. New cases pin the vendor's value
space against RunPod's docs, and mutating the door back to the documented `1280*720` fails **4 of 12**
cases in `tests/alibaba-wan.test.ts`.

**Evidence (RunPod job ids, all on 2026-09-27):** unknown-key-ignored
`sync-5333abdf-39aa-4634-9f8b-87e456abbee9-u2`; vendor enum for `size`
`sync-7334e207-526d-4c70-8ca4-ffcb3284687b-u2`; 1080p delivered
`sync-7eb360c7-9111-43da-91f8-8b2c80f5c72b-u1` ($0.75); `last_image` validated
`sync-5b49ab0a-c139-4db9-afa9-b8b674e6c1c0-u2`; `last_frame_image` ignored
`sync-0c87ae96-ebee-4c80-9fe0-e556bc6c1fb1-u1` ($0.096). Total billed **$0.846**; the four rejected
probes returned no `cost` field. All three docs defects were reported upstream to RunPod.

**Not claimed.** Whether the end frame VISIBLY holds the cut now. `last_image` is proven live and
validated, which is strictly more than was known, but no one has compared final frames. Also unchanged:
`modules/cf-seedance` keeps `last_frame_image`, which is correct for the Cloudflare API.
