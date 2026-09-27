### fix(image-prep): bound the DECODED pixels, not just the compressed bytes (cf#869)

`MAX_INPUT_BYTES` gates **compressed** bytes. The decoded bitmap is a function of **pixel
dimensions**, and nothing bounded those, so the only size gate measured the wrong quantity -- and
measured it confidently.

Demonstrated rather than argued: a structurally valid **69-byte** PNG whose IHDR claims
`20000x20000` decodes to about **1.5 GiB** as RGBA. It passes the 32 MB byte cap by four orders of
magnitude, because compressed size is not a bound on decoded size and an attacker picks the ratio.

`MAX_INPUT_PIXELS` (default `4096x4096`, env-tunable like the other container constants) now bounds
the decode. Three details are load-bearing:

- **It runs before `rembg`, not before `Image.open`.** `rembg.remove()` decodes the input itself,
  ahead of any Pillow call in this module, so a guard placed at `Image.open` would have sat *behind*
  the allocation it exists to prevent.
- **It reads the HEADER only.** `Image.open` is lazy, so `.size` costs nothing and no pixel is
  decoded to decide whether decoding is affordable.
- **Pillow's own bomb check is suspended for that header read, and restored immediately.** Pillow
  raises `DecompressionBombError` above 2x `MAX_IMAGE_PIXELS`, which pre-empted the check and
  surfaced a 400 MP image as *"could not identify image"* -- refused, but for the wrong reason,
  which is the same two-states-as-one defect this guard exists to close. **That was caught by the
  new test, in the first version of this fix.** The global limit stays set as defense in depth for
  any decode that does not come through the probe.

The ceiling is derived rather than round: the subject is a single cast reference portrait, and
`4096x4096` comfortably covers a 12 MP phone photo (`4032x3024`) while bounding the decode at about
64 MiB RGBA. Both ends are pinned by tests, because a ceiling only tested from above could be far
too tight and still look correct.

Refusal is a **413 naming the decoded dimensions** and the ceiling applied, so an operator can tell
"your image is too large to decode" from "the container fell over". An unidentifiable image is now
refused **400** rather than passed to rembg: what cannot be read cannot be bounded, and it would
have failed after the allocation anyway.

`containers/image-prep/test_decode_bound.py`, 12 checks, added to the CI list. It builds the bomb by
hand from a PNG header rather than asking Pillow to create one, because allocating 1.2 GB in a test
is the very thing being prevented. Watched it go red: removing the bound fails exactly the two
refusal checks and leaves every positive control green.

CI installs `Pillow==12.3.0` for that job, pinned to what image-prep itself ships. Not the whole
image-prep requirements file, which pulls rembg and onnxruntime, hundreds of MB of ML runtime this
test never touches.

The README's "residual, stated rather than hidden" paragraph is gone, because the residual is gone.
