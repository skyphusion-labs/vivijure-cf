### fix(keyframe): RunPod Nano Banana 2, no FLUX

cloud-keyframe stills go through RunPod `google-nano-banana-2-edit`.
FLUX on Cloudflare 3030'd hosted shots; RunPod is the promoted
path. Old flux / nano-banana-pro ids clamp to nano-banana-2.
Scatter FAILED now surfaces the shard error (3030) instead of
"owning shard dead". Module 0.1.4.
