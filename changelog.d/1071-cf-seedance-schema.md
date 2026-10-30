### fix(cf-seedance): send each Seedance model the body its Cloudflare schema allows (cf#1071)

The default model is `bytedance/seedance-2.5`. That schema rejects `reference_video`, `1080p`, `4k`, and `9:21`, and it requires `output_format`. The kept voice sample now goes out as one `reference_videos` item on 2.5 and as `reference_video` on the 2.0 family. Duration follows the model: 4-30s on 2.5, 4-12s on 2.0, Fast, and Mini. With a first and last still, 2.5 sends aspect ratio `adaptive`, so a vertical clip depends on a 9:16 keyframe.
