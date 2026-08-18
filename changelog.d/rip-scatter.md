### feat(render): retire film scatter

Film scatter (split motion/film across shards) is retired. One film,
no split. POST /api/storyboard/render/scatter is gone (404). Poll of
leftover scatter-* ids returns 410. Keyframe parallelism is a
single-film keyframe stage, not this door.
