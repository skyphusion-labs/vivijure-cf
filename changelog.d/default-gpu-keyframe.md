### fix(keyframe): own-gpu stills default; cloud-keyframe off RunPod

Omitted keyframe_backend is GPU `keyframe` again. cloud-keyframe no
longer calls RunPod Nano Banana 2; it is Cloudflare
`google/nano-banana-2` only, and it is not the hosted default.
