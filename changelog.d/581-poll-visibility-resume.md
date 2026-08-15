### fix(planner): give every client poll loop a visibility pause WITH a resume (cf#581, cf#573)

PR #563 gave the render poll jitter, backoff and a real visibility pause. PR #575 gave jitter and
backoff to the remaining loops and DELIBERATELY stopped short of the pause, because a pause needs a
matching RESUME per loop and a pause with no resume is a worse defect than the one it fixes: the user
backgrounds the tab, the poll never re-arms, and the panel sits on "pending" forever for a LoRA run,
a music bed or a shot regen that actually completed. This is that follow-up.

**The population, re-derived by union rather than inherited.** The dispatch and PR #575 both said
five files and seven arm sites. Measured at `21f10a9` across four independent matchers
(`setTimeout`/`setInterval`; `pollSchedule`/`armPoll`/`nextPollDelayMs`; `function poll*` definitions
and their re-arm points; other scheduling primitives), the live population is **6 loops in 6 files**,
6 physical timer arms and 16 scheduler call sites. `cast.js` alone has 6 scheduler call sites, not 1.
The zero for other scheduling primitives is paired with a positive control on the same invocation
(`addEventListener`, 162 hits), so it is a real absence and not a dead matcher.

Adoption before this change, with denominators: jitter **6 of 6**, backoff **4 of 6** (two abstain by
design), `document.hidden` guard **2 of 6**, resume path **2 of 6**. `armPoll`, the only function
carrying the hidden refusal, had **1 of 6** consumers.

| loop | route | state-advancing | had a pause |
| --- | --- | --- | --- |
| `planner-render.js` | `GET /api/storyboard/render/<jobId>` | YES | yes (#563) |
| `planner-history-list.js` | `GET /api/storyboard/history` | no | yes |
| `planner-history-row.js` regen | `GET /api/storyboard/render/<jobId>` | **YES** | no |
| `planner-audio.js` music | `GET /api/job/<id>` | no | no |
| `cast.js` LoRA | `GET /api/cast/<id>/lora-status` | no | no |
| `demo-steer.js` | `GET /api/demo/render/<jobId>` | no | no |

**Why the listener had to move into the shared policy rather than into three files.** The ONLY
`visibilitychange` listener in the tree lives in `planner-init.js`, and `planner-init.js` ships on
`planner.html` alone. `cast.html` and `modules.html` load `cast.js` and `demo-steer.js` and have no
visibility handler of any kind, so a pause wired the planner way could never have fired on those
pages at all. `poll-schedule.js` now exposes `createLoop`, which owns the timer, the error streak and
the paused flag, and registers each loop with ONE listener attached per document. Pause and resume
are properties of the mechanism instead of properties of whoever remembered to wire them.

`isActive` is required rather than defaulted. Resume must not restart a loop whose job finished while
the tab was hidden, and pause must not mark a finished loop as paused; only the caller can answer
that. A default of "always active" would be the silent-fallback shape that reads as working, the same
reason `pollPolicy()` throws instead of falling back to a flat interval.

**cf#573, the design question, answered rather than left open.** Should a list view hold a poller on a
state-advancing route? It is not the LIST that holds it: the regen poll is armed at the regen submit
and on restore of a submitted regen, never by rendering the history list, so a list at rest polls
nothing on that path. What was not legitimate is that nothing owned the lifecycle. The `setTimeout`
handle was DISCARDED, so the poll could not be cancelled by anything; there was no visibility pause,
so a backgrounded tab drove `advanceFilmJob` forever; and the `.catch` path re-armed with no cap, so
a dead route was polled indefinitely. The owner is now the loop object, one per regen key, destroyed
on terminal status; across page loads the persisted entry owns it, and that restore was already
age-capped. An attempt cap (`REGEN_MAX_ERROR_STREAK`) bounds the TOTAL, which backoff never did:
backoff bounds only the RATE.

**Base cadences are unchanged, again.** cf#573 says in as many words that it is not a request to
change the interval, and moving a rate in the same change that moves a distribution would confound
the two in any measurement taken across it. **This still changes the poll path that drives
`advanceFilmJob`,** so a load-test result taken after this change has a different driver than one
taken before it: a backgrounded tab now sheds load and resumes, where before it polled forever.

**How the assertions were proven, not assumed.** cf#581 names the resume as the assertion that
matters, and it is not hypothetical that a pause-only suite goes green on the stranding bug: measured
against the pre-change suite, EVERY existing assertion passes on a loop that is paused and never
resumed, because the only resume coverage anywhere was three `toContain` substring checks on
`planner-init.js`. So the new suite asserts deltas (the poll body RAN, the loop reports it resumed),
never absences. Seven mutations were driven red individually and each reddened only its intended
assertions: resume not running the poll (2 red), the base substituted for the default (2), pause not
marking paused (1), the cap removed (1), a listener per loop instead of per document (1), resume
ignoring `isActive` (1), and a migrated loop returned to a bare timer (1). Removing the resume left
the PAUSE test green, which is the demonstration itself. The jitter probe uses a NON-DEFAULT base
(4000, the regen base) because on the default base honoured and substituted are byte-identical.

**Deliberately NOT in scope, stated rather than omitted:**

- **`planner-render.js` and `planner-history-list.js` keep their own visibility wiring** and do not
  register with the shared listener. A loop driven by both would be resumed twice and resume runs the
  poll body, so that exclusion is a correctness property and a test asserts it. The render poll is
  also the instrument the cf#512 load run measures with, and it is already correct; moving the one
  proven loop onto a brand-new primitive in the same change that introduces the primitive is risk
  taken for no gain, immediately before the run. Collapsing those two is a follow-up.
- **`cf#515` defect 2 (the `discoverModules` cache default)** is fixed in `vivijure-core` `main` at
  `11f52aa` (core PR #216), which caches the `MODULE_*` service scan for 30s and re-reads the D1
  dispatch set on EVERY call, exactly the seam that must not go behind one TTL. It is NOT reachable
  from this panel: core `1.15.0` is unpublished (npm tops out at `1.14.0`) and this repo pins
  `^1.14.0` with the lockfile resolving `1.14.0`, so `npm ci` builds the old path. That is a release
  and pin bump, not a panel change.

Refs #581, #573, #515
