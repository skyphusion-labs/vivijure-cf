# Finish capacity and the finish queue

How a film gets a turn on the video-finish tier, and what happens when a finish step fails.
Implementation: `src/finish-queue.ts` and `src/video-finish-assemble.ts` in vivijure-core.

## The queue

The door runs a limited number of jobs. `FinishContainer` allows `max_instances` 20, one for
synchronous calls and 19 for jobs (`RESERVED_JOB_INSTANCES`). Films take those slots first come, first
served, using the `finish_queue` table (migration `0023`). It is on the studio's own database, so it needs
no new binding and no paid feature.

- A film holds its place from its first ask until it finishes, across assemble, mux and film.finish. A
  slot is held only while a job runs.
- A lease is renewed on each poll tick and expires after 20 minutes, so a crashed holder cannot wedge the
  queue. A waiter silent for 10 minutes is skipped and keeps its place if it comes back.
- The door stays authoritative. A 429 after a grant returns the slot, keeps the place, and lowers a
  temporary cap to what is running, for 5 minutes.
- The sweep drives the first 10 waiters on each tick, so a freed slot is taken within a tick.
- A film waits at most 6 hours (`ASSEMBLE_CAPACITY_MAX_WAIT_SECONDS`).

If the table is missing or a call fails, core logs `finish_queue.unavailable` and the film uses retry
with backoff, so a queue fault cannot stop a film.

| Var | Default | Meaning |
|-----|---------|---------|
| `FINISH_QUEUE_SLOTS` | 19 | Jobs the door runs at once. Set it for a door with a different limit. |
| `FINISH_QUEUE_PER_KEY_CAP` | unset | Most slots one project may hold, so a batch or a heavy project cannot take them all while others wait. Unset is plain first come, first served. |

## When a step fails

A module says why a step did not run, in `failure` on its output (`docs/module-authoring.md`).

| What happened | Result |
|---------------|--------|
| No capacity (429) | Hold. Up to 6 hours at assemble, mux and film.finish, up to 1 hour for per-shot, speech and master steps, which must stay under the 90 minute stall ceiling. |
| Unreachable, 5xx, unreadable answer | Hold for up to 15 minutes, because an origin that cannot be reached may never come back. |
| A 4xx, including 401, or the step ran and refused | Named at once. |
| A hold that ran out | Named, with code `wait_exhausted`. |
| A passthrough with no `failure` (an older module) | Named, with code `unclassified`. |
| A CSAM refusal | Terminal. Never held, never listed, never retried. |

A named step lands in `finish_incomplete` with what is kept. The film finishes as `done` when it still has
a film to give, and `failed` when assemble or mux did not run. The panel shows "completed, steps missing"
with a retry button, and a clean green "completed" means the list is absent.

`POST /api/render/film/:id/finish-retry` runs the named steps again. It rewinds to the earliest
stage with a missing step and rebuilds what depends on it. No clip is re-rendered. The film rejoins the
queue at the back. It answers 409 when the film has nothing to retry. Per-shot steps inside a scatter
shard are recorded on the shard and are not retried from the scatter job.

## Events

`finish_queue.waiting`, `finish_queue.granted`, `finish_queue.unavailable`, `assemble.capacity_wait`,
`assemble.transport_wait`, `film.finish_step_hold`, `film.finish_incomplete`, `film.finish_retry`, and
`queue_heads` on `render_sweep`.

## The other door

`film-titles` and `subtitle` reach `VIDEO_FINISH_URL` directly, not the bound door. Where that is the
standalone door in `containers/video-finish/cf-container`, each film gets its own instance there, routed on
`x-vivijure-finish-affinity`, and a full door answers 429. Its `max_instances` matches the slots this queue
hands out.

## How long a free slot can sit

The sweep runs each minute and drives the films holding a slot first, then the first 10 waiters. So a
job's end is seen within a tick and its slot is granted in that same tick: about 1 minute in the ordinary
case, and at most about 2 when a client poll asked the same waiter in the 30 seconds before. A client poll
can only shorten this. It lengthens only if more than 10 slots free in one tick, when a waiter further
back is reached by its sweep page.
