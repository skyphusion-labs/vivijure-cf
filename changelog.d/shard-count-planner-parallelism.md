### feat(planner): parallelism is a visible render control

The main film submit never sent `shardCount`; only the scatter checkbox
path did, so the planner silently used the old default of 2. The number
input is always on the render stage (min 1, label "parallelism (shards)")
and both submit paths send the same `plannerShardCount` helper
(omitted or invalid -> `min(shots, 20)`, clamp `[1, shots]`).
