### feat(modules): keyframe + own-gpu poll report wait accepted|running (cf#307)

Optional additive `wait` on pending `/poll` responses. Maps RunPod `IN_QUEUE` -> `accepted`,
`IN_PROGRESS`/`RUNNING` -> `running`. Host core 1.8+ (PR core#144) stores and surfaces IN_QUEUE
for accepted. Modules that omit wait keep prior behaviour.
