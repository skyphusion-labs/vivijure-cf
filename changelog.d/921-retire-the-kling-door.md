### fix(modules)!: retire the kling door, the vendor no longer sells the capability (cf#921)

`modules/kling` pinned the RunPod public slug `kling-v2-1-i2v-pro`, which returned 401 (exists) on
2026-08-05 and returns **404 `endpoint not found`** now. Every render dispatched to that door failed
at submit, and the scheduled liveness census (cf#934) re-filed it every run as cf#941.

**Retiring rather than repointing is forced by the vendor, not chosen.** All 41 live RunPod public
endpoints were enumerated (three `list-public-endpoints` pages, 41 of 41). Exactly two are Kling and
neither does plain image-to-video: `kling-v2-6-std-motion-control` needs a reference motion VIDEO,
which the `motion.backend` hook carries no field for, and `kling-video-o1-r2v` is multi-reference
r2v, already shipped as the separate `kling-o1-r2v` door, which stays. Silent cinematic i2v is still
served by the other doors in that capability row, so nothing is lost but a name that could not work.

The estate had half-decided this already and never finished: `wrangler.toml.example` said "Kling 2.1
stays in modules/kling but is NOT bound on hosted" with the binding commented out, while the tenant
catalog shipped it anyway. cp#538 dropped the catalog row; this removes the module.

**What went with it, because a retirement that leaves references behind is the next dead reference
somebody finds in three weeks.** The module directory and its unit test; four test rosters; the
commented binding block; `scripts/tenant-release-modules.txt`, so the bundle stops being published
too; and **the demo seed**, which was still installing a door that 404s into every demo tenant
(`migrations/demo/0001_demo_seed.sql`, caught by `security-demo-manifest-count-534`).

**Ten count-bearing assertions moved with it, and that is the system working rather than churn.**
Populations 1 (34 -> 33) and 3 (23 -> 22); the job-log writers (15 -> 14); the cost-door roster
(eight -> seven); the `/ready` roster (24 -> 23); the vendored-contract census (34 -> 33 contracts,
65 -> 63 arms, and the PollResponse/CancelResponse split beneath it); and the published page's
prose denominators. Each one existed because somebody made this exact number wrong before.

**The published-not-catalogued asymmetry CLOSES rather than becoming permanent.** `kling` spent one
day as the only member of that set that arrived by SUBTRACTION (cp#538 took its row while the bundle
stayed published) rather than by being published ahead of a capability. Retiring the module
unpublishes the bundle, so the set is back to six and every member again has the single cause it had
before. The page says so instead of leaving a reader to infer it.

**This PR carries a DECLARED TRANSITION and that is deliberate.** `scripts/matrix-transition.txt`
holds `kling retiring cf#921` (vivijure#830). The hub's row is still live, so the module is gone
while the row remains, and the gate tolerates exactly that one declared name. **Proven load-bearing
rather than assumed:** commenting the line out turns `check:matrix` red with
`1 module(s) named in the matrix do NOT exist ... kling`, and with it the run reads
`TRANSITION kling (retiring, cf#921) -- NOT in modules/, in the matrix; exempted`.

**The line must be DELETED once `skyphusion-labs/vivijure`#829 merges**, and the gate enforces that
rather than trusting anyone to remember: once both sides are consistent the transition is COMPLETE
and a surviving entry is a hard FAIL.

**Not in this change, and it is not mine:** `kling-v2-1-i2v-pro` stays in the control plane's
`PUBLIC_ENDPOINT_ALLOWLIST`. That list is pinned by the plane's own `runpod-proxy-census.test.ts`,
which states in its docstring that it does NOT re-scan this repo: it compares a constant to a
constant and a comment to itself. **So this retirement will not turn the plane red; it will leave the
plane green while the allowlist holds a slug for a module that no longer exists**, and that census is
structurally unable to notice. Routed to the infra lane rather than worked around here.

Gate: `npm run typecheck` exit 0; `npm test` exit 0 (3772 passed, 3 skipped); `conformance`,
`guard:resolve`, `check:catalog`, `check:matrix` all exit 0.

cf#941 is left OPEN on purpose. It should self-close on the next scheduled census run now that the
slug is no longer in `modules/`, and that path has never executed. If it does not, that is a finding
about the workflow and worth more than a tidy issue list.
