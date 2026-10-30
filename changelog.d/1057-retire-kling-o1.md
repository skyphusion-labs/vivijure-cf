### fix(modules)!: retire the kling-o1-r2v door (cf#1057)

The provider requires a reference video, and the `motion.backend` hook has no video to
send, so every render on this door failed after submit. The door is removed and no
longer offered. The other silent motion doors are unchanged. Remove the
`MODULE_KLING_O1_R2V` binding from a rendered `wrangler.toml` before the next deploy.
