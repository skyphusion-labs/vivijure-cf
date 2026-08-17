# Module readiness: what a green sweep does and does not cover

**Read this before quoting a readiness result.** Four different populations of "the modules" exist,
they are different sizes, and confusing any two of them is how cf#295 happened. This page publishes
the denominator so a green sweep cannot be read as covering more than it does.

Generated facts on this page are asserted against source by
`tests/module-readiness-denominators-295.test.ts`. If you edit the table by hand and it drifts from
the modules, that test fails.

## The four populations

| # | Population | Size | Where it is defined |
|---|---|---|---|
| 1 | Modules in this repo | **31** | `modules/*/src/index.ts` (excluding `_shared`) |
| 2 | Modules that WRITE `runpod_job_log` rows | **15** | `recordRunpodJob` + `TELEMETRY_DB` in the module source |
| 3 | Modules PUBLISHED as tenant bundles by a studio release | **24** | `scripts/tenant-release-modules.txt`, resolved by `.github/workflows/studio-release.yml` |
| 4 | Modules PROVISIONED to a tenant, and therefore the only ones `module-readiness` reports on | **19** | `TENANT_MODULE_CATALOG` in `vivijure-control-plane/src/tenant-modules.ts`, mirrored at `scripts/tenant-module-catalog.txt` |

Population 4 is the one an operator actually sees, and it is **19 of 31**.

**Population 4 is the number this page has been wrong about twice (cf#470).** It is defined in
another repo, so this repo mirrors it at `scripts/tenant-module-catalog.txt`. The mirror is checked
against the plane on every CI run by `scripts/check-tenant-module-catalog.mjs`, which fetches the
authority over public HTTPS and fails closed on a fetch error or an empty parse. Before that check
existed the copy lived as a literal inside the test that asserted its length, so the assertion
compared the copy against itself: the catalog went 6 to 7 to 15 and nothing ever failed. **If you
are correcting this page, correct the mirror in the same commit; the test asserts they agree.**

**Populations 3 and 4 are five modules apart, and the gap is the point.** They were briefly equal
-- 7 and 7 -- once `finish-rife` was catalogued (cp#284), which meant the plane could not add a
single further module without a studio release first. cf#394 published nine more (the eight
cost-door modules and `image-generate`), taking 3 to 16; cp#317 then catalogued eight of those nine,
taking 4 to 15. cf#396 published four more, taking 3 to 20. **A published bundle with no catalog row
uploads nothing to anybody**; it exists so the plane can add a row when it is ready, instead of the
two repos taking turns.

The five in the gap are published-not-catalogued **for two different reasons, and neither is drift.**

- **`image-generate`** reads `OPENAI_API_KEY`, an operator-scoped credential, and is gated on #401.
  A live product decision.
- **`audio-master`, `beat-sync`, `film-titles`, `subtitle`** each reach the finishing swarm over a
  Workers VPC service binding, and the plane's `uploadTenantModules` binds no `vpc_service` at all
  (measured 2026-08-07: zero occurrences of `vpc` across the 1295 lines of the plane's
  `src/tenant-modules.ts`, with the matcher proven against three sibling files that do carry it).
  **A catalog row without that binding is worse than no row**: `audio-master`, `film-titles` and
  `subtitle` fall to their unbound guard and return a tagged, degraded passthrough -- the film keeps
  its bytes and gains no mastering, no titles and no subtitles -- while `beat-sync` has no unbound
  guard at all and returns `ok:false` on every `score` invoke. So the hook would read as covered
  while producing nothing. Published first so the bundles exist; the row waits on the binding.

## The table

`/ready` column: an anchored `url.pathname === "/ready"` handler, not a mention in a comment.

| Module | `/ready` | Reports `telemetry.job_log` | Writes job-log rows | Published to tenants (3) | Provisioned to tenants (4) |
|---|---|---|---|---|---|
| alibaba-wan | yes | yes | yes | **yes** | **yes** |
| alibaba-wan-lora | yes | yes | yes | **yes** | **yes** |
| audio-master | yes | no | no | **yes** | no |
| beat-sync | yes | no | no | **yes** | no |
| cast-image | yes | no | no | no | no |
| cf-flux-3-video | yes | no | no | **yes** | **yes** |
| cf-grok-video | yes | no | no | **yes** | **yes** |
| cf-hh1-r2v | yes | no | no | **yes** | **yes** |
| cf-seedance | yes | no | no | **yes** | **yes** |
| cloud-keyframe | yes | no | no | no | no |
| dialogue-gen | yes | no | no | no | no |
| film-titles | yes | no | no | **yes** | no |
| finish-blender | yes | yes | yes | no | no |
| finish-lipsync | yes | yes | yes | yes | yes |
| finish-rife | yes | yes | yes | yes | yes |
| finish-upscale | yes | yes | yes | yes | yes |
| google-veo | yes | yes | yes | **yes** | **yes** |
| image-generate | yes | no | no | **yes** | no |
| keyframe | yes | yes | yes | yes | yes |
| kling | yes | yes | yes | **yes** | **yes** |
| local-gpu | yes | no | no | no | no |
| minimax-hailuo | yes | yes | yes | **yes** | **yes** |
| music-gen | yes | no | no | no | no |
| narration-gen | yes | yes | yes | **yes** | **yes** |
| notify-email | yes | no | no | no | no |
| own-gpu | yes | yes | yes | yes | yes |
| plan-enhance | yes | **no** | **no** | yes | **yes** |
| seedance | yes | yes | yes | **yes** | **yes** |
| speech-upscale | yes | yes | yes | yes | yes |
| subtitle | yes | no | no | **yes** | no |
| vidu-q3 | yes | yes | yes | **yes** | **yes** |

## The two asymmetries, and why each is fine

**`image-generate` is published as a bundle but is NOT provisioned.** So on the hosted door its jobs
are not unrecorded, they **do not exist**. Do not read its absence from a `module-readiness` result
as a missing binding; the control plane carries the same warning at `tenant-modules.ts` precisely
because the natural reading is the wrong one. It is held out on #401 because it reads
`OPENAI_API_KEY`, which is operator-scoped; whether hosted should carry it is a product question and
is not settled here. (`finish-rife` used to be the module in this paragraph. cp#284 catalogued it,
so it is now published AND provisioned AND recording, and this text is the record of a state that
lasted from cf#295 to cp#284.)

**`plan-enhance` is provisioned and askable but writes no job-log row.** It is not endpoint-backed:
it reaches Anthropic through our AI Gateway, so there is no RunPod job to record. Its `/ready`
reports `credentials: { gateway_id, cf_aig_token }` and NO `telemetry` block, so
`probeTenantModuleReadiness` maps it to `credentials: null, job_log: null`. **That is the correct
result, not a fault.** It is excluded from `records_unproven` because its catalog entry sets no
`recordsRunpodJobs`.

## What cf#295 found, and what changed

cf#295 measured 6 of 26 modules implementing `/ready`, so a sweep could not tell "not ready" from
"no endpoint exists". **That is fixed: all 31 now implement it** (the invariant is every
module, not a frozen count; the tree grew with the four CF AI i2v modules on top of main's own
cf#470 growth), and `tests/module-ready-coverage-291.test.ts`
holds the invariant in CI.

**The coverage gap did not go away; it moved, and it got harder to see.** Before, an unimplemented
sweep 404'd and the hole was visible in the result. Now every provisioned module answers 200 and
`module-readiness` looks complete while speaking for population 4, fifteen of thirty-one. A route
that reports a subset without saying so is the same defect one layer up, which is why the
denominator is published here rather than left to be re-derived.

**And then this page did it to itself (cf#470).** The published denominator sat at 7 while the real
value was 15, and the sentence below asserting that a tenant could not reach the GPUless cost door
was false about eight modules for four days. A page that terminates a search is worse than no page,
so the number is now mirrored as data and checked against the authority in CI rather than
maintained by hand here.

## What a green `module-readiness` does NOT tell you

- **Anything about the other 16 modules** (31 minus the 15 in population 4). They are not
  provisioned to tenants, so a tenant provision does not reach them. **This does not include the
  GPUless cost door**: all eight cost-door modules were catalogued by cp#317 and a tenant reaches
  them through the plane-side proxy. The 16 are `audio-master`, `beat-sync`, `cast-image`,
  `cf-flux-3-video`, `cf-grok-video`, `cf-hh1-r2v`, `cf-seedance`, `cloud-keyframe`, `dialogue-gen`,
  `film-titles`, `finish-blender`, `image-generate`, `local-gpu`, `music-gen`, `notify-email`,
  `subtitle`.
- **That any module WORKS.** `/ready` is a credential- and binding-visibility probe. It proves a
  module can see its key and its job-log binding; it runs no job. A module can answer `ok: true` and
  fail every invocation.
- **That the finish tier works end to end.** Lipsync, video upscale and audio upscale each need a
  real submission.
- **Anything under load.** One probe is not a load test.

## Reporting rule

**A readiness sweep must print its denominator and name what it could not probe.** A result that
says "all green" without saying "15 of 31 provisioned modules" will be read as a clean fleet by
whoever was not in the conversation. That is the whole lesson of cf#295 and it applies to this page
too: if you quote the table, quote the population you are quoting.
