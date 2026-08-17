### Fixed: clip-level vendors now declare every core presigned field (cf#590)

`finish-rife` and `finish-blender` vendored `FinishInput` with none of the five
credentialless transport fields core already sends (`video_url`, `output_url`,
`output_key`, `audio_url`, `hash_url`). `finish-upscale` was missing `audio_url`.
A field core adds is invisible to those copies on a dependency bump.

The four finish doors now declare the full FinishInput set; speech-upscale stays
on the SpeechInput set. A test reads core's interfaces from the installed
package and goes red when a vendor has not mirrored a new `*_url` / `output_key`.

Refs https://github.com/skyphusion-labs/vivijure-cf/issues/590
