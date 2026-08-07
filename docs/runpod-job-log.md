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

`migrations/0014_runpod_job_log.sql` plus `migrations/0015_runpod_job_log_error_type.sql`,
one row per job, upserted on `job_id`:

| column | what it is |
|---|---|
| `job_id` | the RunPod job id (upsert key) |
| `module` | the module worker name, a compile-time constant, already public in its `/module.json` |
| `outcome` | `submitted` / `completed` / `backend-error` / `failed` / `gone` / `cancelled` / `unknown` |
| `detail` | the backend error text on a fault, bounded to 160 chars |
| `submitted_at` | unix seconds; NULL only for a legacy poll token that carried no submit time |
| `terminal_at` | unix seconds; NULL while the outcome is `submitted` |
| `error_type` | the fault CLASS as a machine label, e.g. `HarnessError`; bounded to 80 chars; NULL when the endpoint reported none |

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
3. `GET /ready` reports `telemetry: { job_log: "ok" | "unavailable" | "unknown" }`, so an operator
   can ask a deployed worker whether it can record at all, with no render and no GPU spend. It is
   deliberately not part of `ok`: the job log is telemetry, and a module without it still renders.

   **Three states, not a boolean (cf#284).** The field used to be `Boolean(env.TELEMETRY_DB)`, which
   reported the presence of the BINDING, not the ability to record: a worker bound to a database
   where `runpod_job_log` does not exist answered `true` while being structurally incapable of
   writing a row. That was observed in the v1.13.0 pre-tag smoke, not theorised.

   | state | meaning |
   |---|---|
   | `ok` | a read against the table succeeded: it is there and reachable |
   | `unavailable` | definitively cannot record: no binding, or the table does not exist |
   | `unknown` | the probe itself could not answer (the read threw, or outran its 1.5s bound) |

   `unknown` is not `ok`. A boolean has nowhere to put "I could not tell", so it answers that as one
   of the two real states, and the reassuring one is the wrong one.

   The probe is a READ (`sqlite_master`), never a write: a readiness check that inserted would put
   fabricated jobs in the table operators query for real ones. It costs one round trip on a path
   that was previously free, taken deliberately because a free answer to the wrong question is worth
   less than a cheap answer to the right one.

   Honest limit: this proves the table is READABLE, not that an INSERT would succeed. A read-only
   replica would still report `ok`. It closes the observed hole and does not claim to close every one.

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
       SUM(outcome = 'completed')                               AS completed,
       SUM(outcome IN ('failed', 'backend-error', 'gone'))      AS faults,
       SUM(outcome = 'cancelled')                               AS cancelled,
       SUM(outcome = 'unknown')                                 AS unknown_after_retention,
       SUM(outcome = 'submitted')                               AS never_resolved
FROM runpod_job_log
WHERE submitted_at >= ?
GROUP BY module;
```

`never_resolved` is signal, not noise: a row still open long after its window is a job whose end we
never observed, which the lifetime counters cannot show either. `unknown` is different: we tried
reconcile past retention and still had no answer, so the denominator is honest rather than open
forever.

## `cancelled`, and what it is NOT (cf#298)

`cancelled` names one thing: a RunPod `/status` that returned `CANCELLED`. Before it existed, the
module poll paths tested `COMPLETED` and `FAILED` and treated everything else as still running, so a
cancelled job never had a terminal write ATTEMPTED and its row stayed `submitted` permanently.
Observed live: a keyframe job that ran to completion, wrote its PNG to R2 and was booked `CANCELLED`
by RunPod. It also has a denominator consequence, which is why the value matters more than the
label: the endpoint health counters exclude `CANCELLED`, and the modules produce it deliberately
(the F17 spend-leak cancel and the core cancel path), so a cancelled job used to be neither a
success nor a failure nor an open job. It was simply missing from the arithmetic.

**It is not the home for a deliberate refusal.** cf#286 and cf#288 both refused a `cancelled` value
when it was proposed for that purpose, and they were right: a refusal raises inside the handler, the
SDK books the job `FAILED`, and a `cancelled` value would never have fired for the case it was added
for. Refusals are discriminated by `error_type`, below. That reasoning is untouched.

`TIMED_OUT` is the other terminal status the poll paths used to walk past. It is recorded as
`failed` (it is genuine infra, which is where infra failures already live) rather than given its own
value: unlike `CANCELLED` it has not been observed on our endpoints, and a vocabulary member added on
speculation is harder to remove later than one added on evidence.

**The render path is deliberately unchanged.** A terminal status is RECORDED and then the existing
poll-path behaviour runs exactly as before. Telemetry must never gate the render path, and there is a
live counter-example to changing it: the CANCELLED job above had already produced the artifact the
film went on to use, so failing a shot on `CANCELLED` would break a path that works today. What the
chain should DO about a terminal-cancelled job is a render-path question with its own evidence
requirement, filed separately.

## `error_type`, and the three endpoints it cannot help (cf#286 / cf#288)

`outcome = failed` absorbs three different things a reader cannot separate: a deliberate refusal, a
genuine handler fault, and genuine infra (OOM, eviction, crash). All three arrive from RunPod as
`FAILED`. The only thing that tells them apart is the exception class.

Before `error_type`, that class survived only inside `detail`, and only because `error_type` happens
to be the FIRST key RunPod emits. Measured on a real refusal: the raw error string is 1071 chars, the
class name ends at char 73, `detail` is bounded to 160. Eighty-seven characters of headroom against a
vendor reordering its own JSON, with a silent failure mode: the numbers would not break, they would
quietly stop meaning what they say.

`error_type` is extracted at WRITE time from the structured key and normalised
(`<class 'vivijure_backend.harness.handler.HarnessError'>` becomes `HarnessError`). It NEVER reads the
message. Classifying by matching English error sentences is a parser only as fresh as the sample it
was built from, and those strings are ordinary prose that someone will reword without knowing a
classification depends on them.

**NULL means the endpoint did not tell us, which is different from "this was not a refusal."**
`vivijure-backend` emits `error_type`. The three satellite containers (musetalk, video-upscale,
audio-upscale) emit none: a validation refusal and a genuine crash both come back as a bare string in
`error`. So one endpoint of four is classifiable and the other three carry NULL until those
containers emit a structured marker. That gap is stated rather than papered over, because a column
that LOOKED like it had solved the classification problem while covering a quarter of the surface
would be worse than the honest absence.

**Historical rows are not backfilled and not reinterpreted.** Every row written before
`migrations/0015` reads NULL. Mining a class out of a truncated `detail` blob to populate a column
that is supposed to be structured would manufacture exactly the confidence that data does not
support. Anything summarising by `error_type` must treat NULL as unknown, never as a fourth category.

## Closing a lost terminal write (cf#298)

The terminal write happens on the module POLL path. Once the core advances past that phase nothing
polls the job again, so a terminal write lost to a transient D1 error used to be permanent and the
row read as an in-flight job forever. Measured at 2 of 20 module jobs in a run with zero actual
faults: a perfect run presenting as ten percent unexplained.

**Two layers:**

1. **Bounded write retry** inside the existing `RUNPOD_JOB_LOG_TIMEOUT_MS` budget (one delay of
   `RUNPOD_JOB_LOG_RETRY_DELAY_MS`). Narrows the window; does not close a longer D1 outage.

2. **Reconciler** (`reconcileOpenRunpodJobs` / `reconcileOpenRunpodJobsBestEffort` in
   `modules/_shared/runpod-job-log.ts`). On each poll of a wired module, fire-and-forget: list open
   rows for that module older than `RECONCILE_MIN_AGE_SEC` (90s), re-query RunPod `/status/<id>`,
   and write the terminal outcome found. First-terminal-write-wins still holds.

   | RunPod answer | row outcome |
   |---|---|
   | `COMPLETED` / `FAILED` / `CANCELLED` / `TIMED_OUT` | matching terminal (same map as the poll path) |
   | job not found / 404 | `gone` |
   | still `IN_QUEUE` / `IN_PROGRESS` | leave open |
   | transient fetch/D1 error | leave open |
   | age past `RECONCILE_UNKNOWN_AFTER_SEC` (25 min) with no terminal answer | `unknown` |

   Hard constraint that must not be designed around: RunPod keeps async results ~30 minutes and has
   no job-history API. Past that window we record `unknown` rather than inventing `completed`. Two
   jobs from the original report returned COMPLETED inside the window and 404 afterwards.

**Wiring (first ship):** only **keyframe** and **own-gpu** call the best-effort reconciler from
`/poll` -- those are the two modules that produced the measured stuck rows. Other modules can adopt
the same one-liner later; there is no cross-module cron in this PR.

**Best-effort forever:** the reconciler never throws, never rejects, never gates the render poll.
`tests/runpod-job-log.test.ts` covers status mapping, deliberately dropped terminal writes closing
after re-query, `unknown` after retention, and non-throwing failure modes.
