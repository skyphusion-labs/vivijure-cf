### fix(render): scatter only for own-gpu

Cloud i2v (Seedance, Veo, Flux, Kling, Wan cloud) is one film job.
Provider rate limits. Parallelism is our GPU pool, not theirs.
