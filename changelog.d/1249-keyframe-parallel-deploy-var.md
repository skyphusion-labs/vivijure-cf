### feat(deploy): set KEYFRAME_PARALLEL from the deploy env

`KEYFRAME_PARALLEL` (how many keyframe invokes one film starts at once) is now rendered into the
Worker's vars like `PANEL_HOME`: set it in `deploy.env` (or the `KEYFRAME_PARALLEL` repository
variable for the CI deploy). Before this it could only be set with `wrangler deploy --var`, so a
plain deploy silently put it back to the default. Blank means 4, the existing default, so existing
deployments do not change.
