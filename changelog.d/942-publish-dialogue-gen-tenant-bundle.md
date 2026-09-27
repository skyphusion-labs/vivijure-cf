### feat(release): publish `dialogue-gen` as a tenant bundle (cp#524)

A hosted tenant has had no way to synthesize a spoken line at all. Both `dialogue` providers,
`dialogue-gen` and `chatterbox`, were absent from `scripts/tenant-release-modules.txt`, so no studio
release published either as a tenant bundle -- and nothing withheld them: a `grep -rc` of the
control plane returns `chatterbox` 0 and `dialogue-gen` 0 against positive controls `keyframe` 29
and `seedance` 3. It was never a decision, only an unwired lane.

`dialogue-gen` goes first because it is the simpler of the two: Deepgram Aura-1 through our own AI
Gateway, so it needs the AI-Gateway trio the plane already binds plus the tenant R2 bucket.
`chatterbox` additionally reaches a RunPod public slug (`chatterbox-turbo`, which is not in the
plane's `PUBLIC_ENDPOINT_ALLOWLIST`) and so carries a second decision; it stays unpublished here.

**This publishes a bundle and catalogues nothing**, which is the established shape: a published
bundle with no `TENANT_MODULE_CATALOG` row uploads nothing to anybody, and it exists so the plane
can add the row in one repo instead of the two taking turns. The row genuinely cannot land yet --
`dialogue-gen` declares a Workflows binding (`DIALOGUE_WORKFLOW`) and the plane cannot emit one.
cp#526 grew the `workflow` variant and live-proved Workers for Platforms accepts it and reads it
back, and the same run measured that a bound upload does NOT create the account-scoped Workflow, so
an emitter owes both. Until then a catalog row would give a tenant a door that provisions, passes
`/ready` (which reports `gateway_id` and nothing else) and throws at the first invoke.

Ordering, which is the trap on this change and is why the bundle leads: a catalog row naming a
module the pinned `STUDIO_RELEASE` does not publish fails EVERY provision at `modules_upload`, and
typecheck cannot see it. The bundle has to exist in a released artifact before the plane may name it.

Population 3 goes 22 to 23 in `docs/module-readiness-coverage.md`, and the published-not-catalogued
set gains a third distinct reason alongside `image-generate`'s operator credential and the four
own-iron finishing modules' VPC binding.
