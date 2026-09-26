### fix(keyframe): expose scene_lock knobs on the SDXL door

`scene_lock` (default on) and `canny_scale` (default 0.70) ride
`render_overrides.keyframe` so the still stays in the location. Off is
a debug hatch. Unknown keys on older backend images are ignored. No
`scene_denoise`. Module 0.3.2.
