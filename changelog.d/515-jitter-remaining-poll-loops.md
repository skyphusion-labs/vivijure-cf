### fix(planner): jitter and back off the remaining client poll loops (cf#515)

PR #563 fixed the render poll and shipped `public/poll-schedule.js` as the shared policy. It did not
fix the rest of the herd. Five more self-rescheduling loops, seven arm sites in total, were still
re-arming at a flat interval with no jitter, measured identically at `v1.27.0` and on `main`:

| file | interval | route |
| --- | --- | --- |
| `demo-steer.js` | 8000 | `GET /api/demo/render/<jobId>` |
| `cast.js` | 5000 | `GET /api/cast/<id>/lora-status` |
| `planner-audio.js` (2 sites) | 5000 | `GET /api/job/<id>` |
| `planner-history-row.js` (2 sites) | 4000 | `GET /api/storyboard/render/<jobId>` |
| `planner-history-list.js` | 30000 | history refresh |

**This changes the poll path that drives `advanceFilmJob`.** `planner-history-row.js` polls
`GET /api/storyboard/render/<jobId>`, the same route as the main render poll, the one that closes a
film's renders-DB row and therefore sets observation lag (cf#512 metric 2). It does so at a HARDER
4s cadence than the render poll's 8s, from two arm sites, and it can run CONCURRENTLY with the
render poll while a board is polling. A load-test result taken across this change has a different
driver than one taken before it, and that is recorded here deliberately rather than left for
someone to discover in the numbers.

`planner-audio.js` carried the flat error-path re-arm that PR #563 fixed for the render poll, still
live: on a poll error it re-armed at the same `MUSIC_POLL_MS`, so a studio having a bad minute was
retried at full rate by every open panel at once. `cast.js` and `planner-history-row.js` had the
same shape. All three now back off through the shared policy and reset the streak on a good poll.

The base cadences are all unchanged. Only the DISTRIBUTION of arrivals moves, for the same reason
#563 left the render cadence alone: moving the rate as well would confound two effects in any
measurement taken across the change.

`public/poll-schedule.js` now also loads on `cast.html` and `modules.html`, which host `cast.js` and
`demo-steer.js` and previously had no access to it. `settings.html` arms no poll and deliberately
does not load it; a test asserts that, so "fix" it everywhere and the pair fails.

**Deliberately NOT in scope, stated rather than omitted:**

- **Visibility pause.** Only `planner-render.js` (via #563) and `planner-history-list.js` pause on
  `document.hidden`. Adding it to the others needs a matching resume path per loop, and a pause
  without a correct resume strands a user's in-flight LoRA, music or regen poll permanently, which
  is a worse defect than the one being fixed. Jitter is the property the synchronisation argument
  actually turns on. Filed as follow-up rather than smuggled in here.
- **`cast.js`'s bounded refs-job loop** (`await new Promise((r) => setTimeout(r, 1500))`). A bounded
  `for` loop capped by `maxPolls`, not a self-rescheduling timer, and each GET drives one image
  render server-side. Different shape, left alone, and asserted by a test so its absence from this
  change reads as a decision and not an oversight.

Refs #515
