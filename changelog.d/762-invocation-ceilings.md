### docs(modules): justify the finish ceilings, gate the 1800 crossover (cf#762)

Three modules declare `max_invocation_seconds`, not five: `speech-upscale` and `finish-lipsync` were
excised and took their 300 and 900 with them. `finish-blender`, `finish-rife` and `finish-upscale`
each declared **900** with nothing at the edit site saying what that number does.

It is not a local number. Core derives the effective phase deadline in `phaseCeiling`:

```
required  = FINISH_STEP_MAX_ATTEMPTS(3) * max(declared ceiling over the steps that run next)
effective = max(PHASE_HARD_DEADLINE_SECONDS(5400), required)
```

At 900 `required` is 2700 and the floor wins. Above **5400/3 = 1800** the derivation overtakes the
floor and a GLOBAL per-phase deadline moves for every film whose finish chain can REACH the module,
including the films that never invoke it, because the derivation takes the max over the steps that
COULD run next.

**Basis per module, stated at each declaration site.** `finish-blender` keeps 900 because that is the
worker's own deploy configuration (`EXECUTION_TIMEOUT_MS` default `900000` in `vivijure-blender`
`deploy.sh`, passed as `executionTimeoutMs` on endpoint create); it is NOT a live reading, and the
comment says so, because no `vivijure-blender` endpoint exists (RunPod `list-endpoints` returns
`total: 2`, and the control plane carries no blender pin). **The 5400 proposed by the superseded PR is
refuted and was backwards:** 5400 is that repo's own `PHASE_HARD_DEADLINE_SECONDS`, the ceiling the
door must stay UNDER, not a duration the worker permits; its real worst case,
`declared_budget_seconds("composite")`, is 4320s and is itself a sum of per-leg guards.
`finish-rife` and `finish-upscale` are declared **uniform with a stated reason** rather than given an
invented number: rife's endpoint (`vivijure-backend`) reports `timeout: 0`, no execution timeout is
configured and the Worker sends no per-request `policy.executionTimeout`; upscale's endpoint no
longer exists at all (cf#757). There is nothing to measure, and saying so is the honest value.

**A comment is not a mechanism, so the threshold is enforced.**
`modules/_shared/finish-ceiling.ts` derives the crossover from core's two constants (never a typed
1800) and holds the acknowledgement registry, empty. `tests/finish-ceiling-crossover-cf762.test.ts`
scans every module's manifest source and fails on a declaration above the crossover with no
registered acknowledgement, a stale or reasonless acknowledgement, an acknowledgement outliving its
declaration, or a declaration site that does not name the threshold. It runs core's own
`phaseCeiling` at 1800 and 1801 rather than restating the arithmetic, and it checks its own
instrument: the scan must account for every module that mentions the field, so a broken regex cannot
pass vacuously. Both failure paths were watched RED (rife at 1801; the comment stripped) and
reverted.

Fix-forward: `modules/_shared/video-finish-404.ts` still claimed no finish-chain module declares a
ceiling. Three do; corrected, with the stale sentence recorded so the correction is not re-derived.

No behaviour change: every declared value is unchanged at 900, so core's effective ceiling stays on
its 5400 floor exactly as before.
