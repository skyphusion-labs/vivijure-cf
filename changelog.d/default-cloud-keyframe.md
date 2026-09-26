### fix(render): default stills to cloud-keyframe

Omitted `keyframe_backend` now resolves to `cloud-keyframe` (faster
than GPU SDXL). Explicit pick still wins. `local-gpu` is left alone
so core can couple it. Module `ui.order` 5 so the registry default
matches. Cloud-keyframe 0.1.3.
