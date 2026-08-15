### refactor(job-log): the RunPod job log moves to vivijure-core; this repo re-exports it (#475)

`modules/_shared/runpod-job-log.ts` becomes a one-line pointer at
`@skyphusion-labs/vivijure-core/runpod-job-log`. No module worker changes: all 97 call sites keep the
specifier they already write, and `env.TELEMETRY_DB` still typechecks, because core types the handle
as the structurally identical platform `Database`.

WHY. Cast LoRA training submits to RunPod from CORE, which sits upstream of this file and could not
import it, so it recorded nothing: the `vivijure-wan-train` endpoint billed 14.5% of GPU spend on
2026-08-01 and 21.9% on 2026-08-02 with ZERO rows in `runpod_job_log` on either day. The alternative
was a second recorder for one table, and the estate already had two copies that had drifted
(vivijure-local still truncates `detail` at 160, has no `unknown` outcome and no timing columns). Same
move, same reasoning as cp#321 did for `runpod-route.ts`.

`tests/runpod-job-log-reexport-cf475.test.ts` asserts the surface at runtime, asserts identity rather
than shape, asserts the cf#320 bound and cf#298 vocabulary arrive through the pointer, and asserts the
file declares nothing of its own -- the guard on the deletion, not on the survivor.

Requires `@skyphusion-labs/vivijure-core@^1.16.0`.
