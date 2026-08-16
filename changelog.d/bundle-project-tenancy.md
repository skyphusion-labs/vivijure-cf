### fix(render): do not send a project the bundle does not belong to

GPU keyframe / own-gpu films failed when the caller slug (a loadtest
project, a reused bundle) did not match `bundles/<project>-<hash>.tar.gz`.
Backend tenancy is correct. Film submit, scatter, from-keyframes, MCP,
and the GPU keyframe module now derive the project from the key on a
mismatch so RunPod never sees the pair.
