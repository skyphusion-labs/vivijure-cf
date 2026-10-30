### feat(modules): refresh image model enums against the catalog (cf#1076)

`google/imagen-4` is gone: its model page and schema-input.json 404. The picker
offers `openai/gpt-image-2`; `gpt-image-1.5` stays runnable for a saved session
and is still the transparent-PNG path. Keyframe can select `google/nano-banana-2.1`
and `pruna/p-image-edit`. Cast references can select `black-forest-labs/flux-3-image-klein`.
The image catalog can select `bytedance/seedream-5-lite`. No default changed.

`google/imagen-4` leaves the picker and stays runnable, so a saved config still resolves. A live check is still owed before it is dropped. A saved `cloud-keyframe` model is now honoured when it is in the module's list. Anything else falls to `google/nano-banana-2`.
