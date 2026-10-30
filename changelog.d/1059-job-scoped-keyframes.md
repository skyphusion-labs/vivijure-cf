### fix(cloud-keyframe): concurrent renders of one project keep their own stills (cf#1059)

Each job now writes `renders/<project>/keyframes/<job>/<shot>.png`. A flat key let one render replace
another's still, which failed the keyframe similarity gate on an otherwise good clip. The GPU `keyframe`
door is unchanged. The render route contract now states that a mismatched `project` is remapped. A film delete now also removes that film's own job-scoped stills. The contract records the 5-minute settle window.
