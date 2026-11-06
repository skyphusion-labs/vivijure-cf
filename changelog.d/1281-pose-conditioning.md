### feat(keyframe): a pose skeleton switch for two-person stills

The `keyframe` module (0.3.9) has a `pose_conditioning` setting for two-person stills (cf#1281): `auto` (the default) sends nothing, so the backend picks per path (vivijure-backend#596: a scene-lock plate draws without the pose skeleton while the plate count guard runs, and the plain regional path draws with it). `on` or `off` sets both paths, sent as `multi_char.pose_conditioning`. It is an enum, not a bool, because the core fills every schema default, so a bool could never stay unset. Older backend images ignore it.
