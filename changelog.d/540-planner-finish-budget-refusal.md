### Added

- **The planner refuses a shot the selected finish chain cannot finish, before the GPU is booked
  (cf#540).** `SCENE_MAX_SECONDS` admits 60s and its comment justifies that by Wan I2V motion cost;
  it is silent about finish cost, and the finish door has a budget of its own that a 60s shot cannot
  fit inside. Three constants govern this in three repositories (`FFMPEG_TIMEOUT = 1200` in the
  upscale handler, `PHASE_HARD_DEADLINE_SECONDS = 5400` in core, `SCENE_MAX_SECONDS = 60` in core),
  none referencing another and nothing asserting any relationship between them, which is how they
  came to disagree silently. `public/finish-budget-checks.js` derives the permitted length from the
  finish chain THIS render selects and emits an `error` per over-budget scene, naming the number,
  the chain, the door budget, the rate and the measurement's provenance. A silent clamp was never a
  candidate: it produces a film the user did not ask for and did not consent to.
- **No fourth constant.** The new file carries no number at all. Every term comes from a module's
  own manifest, which reaches the browser unchanged because registry `toPublic` strips only
  `binding`, so a module that declares its cost lights this up with no further UI work. Selection
  mirrors the core's `selectForChain` for the `finish` hook, consuming cf#537's `participation`
  rather than inventing a second policy. Issues are emitted in the server preflight's own shape, so
  they merge into the existing list and the existing errors-gate-the-bundle rule with no parallel
  surface.
- **Unknown admits, and is never silent.** No manifest declares a finish cost yet, so refusing on
  unknown would refuse one hundred percent of correct work on day one, and a guard that fires on
  correct work is the guard people switch off. A wrong refusal costs the guard itself; a wrong admit
  costs one job that dies at the door guard, which is today's behaviour and is recoverable. So an
  underivable ceiling ADMITS and reports one info line naming the modules that declared nothing,
  once per render rather than once per scene, and a test asserts that notice never says the shot is
  safe or will finish. A registry that failed to load is a THIRD state, because "I could not ask"
  and "this studio installed none" are different facts owned by different parties (cf#344); a test
  drives both with otherwise identical inputs and asserts they differ.
- **Every guard mutation-tested.** Each was patched to a fall-through and watched go red for its own
  named reason with the siblings staying green in the same run, the patch's application asserted
  (`applied 1 of 1`, abort on zero) and the restore verified back to baseline. 7 of 7 red, 0
  untested. This ships the planner half only: the core cap, the upscale host-memory guard and the
  `finish_cost` manifest field remain open elsewhere.
