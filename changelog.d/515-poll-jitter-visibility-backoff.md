### fix(planner): jitter, pause and back off the render poll (cf#515)

The render poll re-armed on a flat 8000ms from four bare `setTimeout` call sites, with `Math.random`
appearing zero times anywhere under `public/`. Unjittered self-rescheduling timers synchronise, so
panels starting inside one window converged onto the same 8s boundary and stayed there, arriving as
a spike; the `visibilitychange` handler cleared only `historyRefreshTimer`, so a backgrounded tab
polled forever and could never shed load; and both error paths re-armed flat.

This is a change to a MEASUREMENT INSTRUMENT and is recorded as one. `GET
/api/storyboard/render/<jobId>` drives `advanceFilmJob` and therefore closes a film's renders-DB
row, so the poll cadence is what sets observation lag, the metric cf#512 insists must never be
folded into latency. Ruled fix-anyway on cf#515: the unfixed behaviour is itself an artifact and a
worse one, because real clients drift and an unjittered never-pausing panel is a synthetic arrival
pattern authoring a spike production would never see. The base cadence is deliberately unchanged;
only the distribution moves.

Adds `public/poll-schedule.js` (pure, UMD-ish, mirroring `render-eta.js`) with `random`, the timer
and the hidden flag all injected, because the interval was previously inline in the `setTimeout`
call where no test could address it. `armPoll` refuses to arm at all while hidden rather than arming
a longer timer. Every arm goes through one `schedulePollRender()` and a guard asserts no raw
`setTimeout(pollRender, ...)` survives; `POLL_INTERVAL_MS` is retired rather than duplicated
alongside `pollSchedule.POLL_BASE_MS`. Plus `public/poll-schedule.d.ts` and
`tests/poll-schedule-515.test.ts`, whose six guards were each driven red individually with
sibling-green pairing.

Refs cf#515 defect 1 only. Defect 2 (uncached `discoverModules`) stays open: core `main` still reads
`const ttl = opts.cacheTtlMs ?? 0;`.
