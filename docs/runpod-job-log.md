# The RunPod job log (cf#279)

A durable D1 row per RunPod job that a module worker submits and polls. It exists because the modules
held the job id and the terminal reason at the exact moment a job ended and wrote neither, and because
RunPod cannot enumerate jobs: the whole job surface is `/run`, `/runsync`, `/status`, `/stream`,
`/cancel`, `/retry`, `/purge-queue`, `/health`, and `/status` is by id only. An id nobody wrote down is
unreachable permanently, and the window to write it closes as the job finishes.

Ruled by Conrad 2026-08-01: a durable row rather than `tail_consumers`, and BEFORE the cf#278 phase 1
stress test, because phase 1 generates exactly the jobs worth classifying and running it first spends
the run and leaves cf#277 where it is.

## What is recorded

`migrations/0014_runpod_job_log.sql`, one row per job, upserted on `job_id`:

| column | what it is |
|---|---|
| `job_id` | the RunPod job id (upsert key) |
| `module` | the module worker name, a compile-time constant, already public in its `/module.json` |
| `outcome` | `submitted` / `completed` / `backend-error` / `failed` / `gone` |
| `detail` | the backend error text on a fault, bounded to 160 chars |
| `submitted_at` | unix seconds; NULL only for a legacy poll token that carried no submit time |
| `terminal_at` | unix seconds; NULL while the outcome is `submitted` |

Content-free: every column is an id, a compile-time constant, a closed-set label or a timestamp. The
one field carrying third-party text is `detail`, held to exactly the standard `renders.error` is
already held to in the same database.

**The RunPod endpoint id is deliberately NOT a column.** It arrives from the Secrets Store and the
module `/ready` probe reports it as a boolean and never as a value; writing it into a queryable table
would break that convention. The module name is a sufficient substitute for the cf#277 question,
because the module-to-endpoint mapping is fixed in each module wrangler.toml and public in this repo:

| module | endpoint |
|---|---|
| `keyframe`, `own-gpu`, `finish-rife` | the render backend endpoint |
| `finish-upscale` | the video-upscale endpoint |
| `finish-lipsync` | the musetalk endpoint |
| `speech-upscale` | the audio-upscale endpoint |

## Why a submit row and not only a failure row

cf#277 asks for a failure RATE. A rate needs a denominator, and the endpoint health counters cannot
supply one: they bucket four terminal statuses into two, and `completed + failed` excludes `CANCELLED`,
which these modules produce deliberately (the F17 spend-leak cancel). Rows only for failures would
answer "how many of these did we see" and not "out of how many", which is the question.

The submit row costs one call at a site where the id is already in hand, in the same file. The
expensive part (the table, the helper, the binding, the deploy plumbing) is paid once either way.

What it buys: per-module denominators, `CANCELLED` accounting, and reconciliation against RunPod counters.
What it does not buy: it does not CLASSIFY handler fault vs deliberate refusal vs infra -- that reads
`detail` and is a judgement, not a column. It does not see cast-LoRA training jobs (the core submits
those, not a module worker) or the third-party cloud modules (they run on RunPod PUBLIC endpoints,
whose counters are not ours). Those gaps are stated rather than papered over.

## The row and the `degraded` response field record DIFFERENT facts

They can disagree, and neither is derived from the other:

- **`degraded`** (in the module response) is what the CHAIN did: this step passed its input through.
  It is the contract with the caller and the thing the orchestrator and the user act on. It is
  **authoritative for chain behaviour.**
- **the row** is what the ENDPOINT did: a job with this id reached this terminal state at this time.
  It is **authoritative for endpoint behaviour**, and for nothing else.

The divergence is one-directional by construction. The write is best-effort, so a row can be MISSING
for a degrade that really happened; a row can never assert a degrade that did not, because it is
written only on the path that also returns the degrade. And on the finish satellites the terminal
backend-error path returns `ok:false` rather than a `degraded` passthrough, so a row can exist with no
`degraded` anywhere. That is why the row carries its own `outcome` and must never be read as "the chain
degraded". A query about what the USER experienced reads the film/render state, not this table.

`completed` is recorded BEFORE the output is parsed, for the same reason: the endpoint completing and
us being able to use its output are two facts, and the response carries the second one.

## Best-effort, and what that guarantees

`modules/_shared/runpod-job-log.ts` never throws, never rejects, and never delays its caller by more
than `RUNPOD_JOB_LOG_TIMEOUT_MS`. A telemetry failure that converted a soft degrade into a hard failure
would be strictly worse than the gap it closes. Every failure mode exits as a warn plus a return:
absent binding, empty job id, a `prepare`/`bind` that throws synchronously, a `run` that rejects, a
non-Error throw, and a write that HANGS (raced against the timeout and abandoned).

`tests/runpod-job-log.test.ts` drives each of those through a caller that returns a value AFTER
awaiting the helper, so a broken guarantee shows up as a missing return. All six guarantee tests were
confirmed to go red under a mutation that removes the try/catch, the rejection handler and the timeout
race, and green again when restored.

The SQL is not proven by those tests. A fake D1 accepts any string, and this repo has shipped a route
that could not succeed for any input because bare words in a SQL string parsed as column references
while green tests never handed a real string to a real engine. So the DDL and the upsert were run
against a real D1 (`wrangler d1 execute --local`), and the helper itself was driven through a real
binding under `wrangler dev` -- including a run with the table DROPPED, where the real
`D1_ERROR: no such table` produced a warn and the caller still returned normally.

## Absence must not read as a clean run

The failure this whole lane is about is a view that cannot distinguish two cases answering as though
it can. So "no rows" is made distinguishable from "cannot write rows" three ways:

1. the deploy fails loudly on an unfilled `database_id` placeholder (a dangling binding), rather than
   shipping a worker that silently records nothing;
2. an absent binding warns with its own marker on every call;
3. `GET /ready` reports `telemetry: { job_log: <bool> }`, so an operator can ask a deployed worker
   whether it can record at all, with no render and no GPU spend. It is deliberately not part of
   `ok`: the job log is telemetry, and a module without it still renders.

## Deploy

`database_id` is a placeholder in the tracked tomls. It is filled at deploy time by
`scripts/deploy-module-workers.sh` (from the `D1_DATABASE_ID` repo secret the core render already
consumes -- no new deploy configuration was introduced) and by `replace_d1_id_placeholder` in the
installer, which restores the placeholder afterwards so a checkout is never dirtied with an account id.

**Not covered by this change: the hosted provisioner.** Module release bundles carry no bindings
(`scripts/build-module-release.ts` writes the worker plus compat config only); the control plane
attaches bindings at WfP upload, in its own repo. Until it binds `TELEMETRY_DB`, hosted tenant modules
will not record -- visibly, via 2 and 3 above, rather than silently.

## Growth and retention

No pruning is built, deliberately. One row per RunPod job at roughly 150 bytes: the busiest endpoint
had 835 lifetime completions when cf#277 was written, so the whole estate to date is well under a
megabyte against a 10 GB D1 limit. The rows are content-free, so no retention obligation applies and
any window is a housekeeping choice rather than a compliance one.

Proposed when it becomes load-bearing, not before: a single
`DELETE FROM runpod_job_log WHERE submitted_at < ?` on a 90-day window, on the scheduled handler that
already exists, plus a row-count check so the prune is visible. The trigger to build it is a measured
row count, not a hunch.

## The cf#277 query

```sql
SELECT module,
       COUNT(*)                                                   AS jobs,
       SUM(outcome = completed)                                 AS completed,
       SUM(outcome IN (failed, backend-error, gone))        AS faults,
       SUM(outcome = submitted)                                 AS never_resolved
FROM runpod_job_log
WHERE submitted_at >= ?
GROUP BY module;
```

`never_resolved` is signal, not noise: a row still open long after its window is a job whose end we
never observed, which the lifetime counters cannot show either.
