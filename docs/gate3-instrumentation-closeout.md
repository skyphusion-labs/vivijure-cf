# Gate 3 instrumentation closeout (cf#279, cf#295)

Evidence-backed disposition for two issues whose **original defects are closed in code**
and whose residual gaps are either structural or filed separately. Read this before
reopening either issue on the strength of the original body.

## cf#279 -- soft-degrade records job id + reason

**Original defect:** module soft-degrade held the RunPod job id and reason and wrote neither.

**Shipped:**

| piece | where |
|---|---|
| D1 table + upsert | `migrations/0014_runpod_job_log.sql`, `0015_runpod_job_log_error_type.sql` |
| writer + readiness probe | `modules/_shared/runpod-job-log.ts` |
| first ship (6 modules) | PR #280 / v1.13.0 |
| cost-door GPUless modules (remaining 8 of 14) | PR #323 / v1.14.x lineage |
| cancel / error_type / walked-past terminals | PR #304 |
| write retry | same telemetry truth PR series |
| reconciler for lost terminal write | PR #425 (cf#298; open for Mackaye) |
| visible detail truncation | PR #426 (cf#320; open for Mackaye) |

**Measured coverage today (source, not memory):** 14 of 14 RunPod-polling modules call
`recordRunpodJob`. The modules that soft-degrade and poll RunPod are instrumented.

**Structural residual (not this issue):** cast-LoRA / wan-train jobs are submitted from
**vivijure-core**, not a module worker. The module-side shim cannot see them. That is a
core-action seam, not a missing module line. Do not reopen #279 for wan-train.

**Close when:** this page is on main and Mackaye accepts the disposition.

## cf#295 -- readiness denominator

**Original defect:** 6 of 26 modules implemented `GET /ready`, so a readiness sweep could not
tell "broken" from "not implemented".

**Shipped:**

| piece | where |
|---|---|
| `/ready` on all 26 modules | PR #308 / v1.14.0 |
| published denominators + CI guard | PR #313, `docs/module-readiness-coverage.md`, `tests/module-readiness-denominators-295.test.ts` |

**Measured coverage today:** 26 of 26 modules have an anchored `url.pathname === "/ready"` handler.

**What moved, and stays true:** `module-readiness` on the control plane only probes
**population 4** (tenant catalog, currently 7 modules). A green result is "7 of 26 provisioned
modules", never "the whole fleet". That is documented and guarded; it is not a regression of
the original `/ready` gap.

**Close when:** this page is on main and Mackaye accepts the disposition.

## Reporting rule (unchanged)

A readiness or job-log sweep must print its denominator and name what it could not probe.
