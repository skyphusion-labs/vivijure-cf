### Feat: the keyframe module offers the Pass B gaze clause (cf#1442)

The keyframe module (0.3.12) declares `pass_b_gaze`: `off` (the default) or `auto`. With `auto`, on a two-person still, the backend reads what the shot text says the people are looking at ("looking at a laptop") and tells the second pass to keep their eyes on it, not on the camera. `off` sends nothing, so a default render's request and reuse hash are unchanged. It needs vivijure-backend with `keyframe.pass_b_gaze` (vivijure-backend#651); an older backend ignores it.
