// Pure poll-scheduling policy for the planner render poll (cf#515).
//
// NO DOM access on purpose: this unit-tests under plain Node
// (tests/poll-schedule-515.test.ts) and also loads as a classic <script> on
// planner.html, exposing `window.pollSchedule`. The UMD-ish wrapper picks
// CommonJS when `module` exists (the test harness) and a global otherwise
// (the browser), so one file serves both with no build step. Mirrors
// render-eta.js and lora-preflight.js.
//
// WHY THIS IS NOT COSMETIC, and why it is a change to a MEASUREMENT
// INSTRUMENT rather than an ordinary panel tidy-up:
//
// GET /api/storyboard/render/<jobId> is not a read. It is one of the two
// drivers of advanceFilmJob (the other is the 60s cron sweep), so it is also
// what closes a film's renders-DB row. That makes the poll cadence the thing
// that sets OBSERVATION LAG -- cf#512's metric 2, completed_at minus
// last_progress_at, which that issue insists must never be folded into
// latency. Changing this file changes what a load test measures. Ruled
// fix-anyway on cf#515 (comment 5298247600) on the grounds that the UNFIXED
// behaviour is itself an artifact and a worse one: real clients drift, so an
// unjittered never-pausing panel is a SYNTHETIC arrival pattern that authors a
// spike the system would never see in production.
//
// The two defects this closes, both measured on the shipped panel:
//
//   1. NO JITTER. The loop was a self-rescheduling setTimeout at a flat
//      POLL_INTERVAL_MS with `Math.random` appearing ZERO times anywhere under
//      public/. Unjittered self-rescheduling timers SYNCHRONISE: clients that
//      start within one window converge onto the same 8s boundary and stay
//      there, so N panels arrive together instead of spread across the
//      interval. Worse under load, which is exactly when it matters, because
//      more concurrent films means more open panels.
//
//   2. NO VISIBILITY PAUSE. planner-init.js's visibilitychange handler cleared
//      historyRefreshTimer and never renderState.pollTimer, so a backgrounded
//      tab polled forever and a run could not shed load. The pattern already
//      existed one file over (planner-history-list.js guards on
//      document.hidden); it had simply never been applied to the render poll.
//
// Also folded in: BACKOFF. Both error paths re-armed flat, so a studio having
// a bad minute got hammered at full rate by every open panel simultaneously.
//
// DESIGN NOTE -- why everything is injected. random, the timer and the hidden
// flag are all parameters rather than globals so the policy is reachable from
// a test without a DOM. An earlier shape had the jitter expression inline in
// the setTimeout call, and nothing could address it: the value that decides
// the whole behaviour was unreachable from any seam. If a knob cannot be
// driven from a test it is not a knob, it is a constant with an opinion.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.pollSchedule = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Base cadence. Unchanged from the pre-cf#515 POLL_INTERVAL_MS: this change
  // is about the DISTRIBUTION of poll arrivals, not their rate. Deliberately
  // so -- moving the rate as well would confound the two effects in any load
  // measurement taken across the change.
  const POLL_BASE_MS = 8000;

  // Jitter window, as a multiplier on the base: [0.85, 1.15), i.e. 6800ms to
  // 9200ms on the 8s base. Wide enough that clients starting in the same
  // second are spread across ~2.4s and never re-converge, narrow enough that
  // the worst-case observation lag added is under 1.2s. random() is [0,1), so
  // the top of the band is approached and not reached.
  const JITTER_MIN_FACTOR = 0.85;
  const JITTER_SPAN = 0.3;

  // Error backoff. Doubling per consecutive failure, capped, so a studio
  // outage does not get retried at full rate by every open panel at once.
  // The cap keeps a recovered studio noticed promptly rather than after an
  // unbounded exponential wait.
  const BACKOFF_FACTOR = 2;
  const BACKOFF_MAX_MS = 60000;

  function clampStreak(errorStreak) {
    const n = Number(errorStreak);
    if (!Number.isFinite(n) || n <= 0) return 0;
    // Bound the exponent before it is used, so a pathological streak cannot
    // produce Infinity and hand NaN to setTimeout.
    return Math.min(Math.floor(n), 32);
  }

  // The delay to wait before the next poll, jittered, with backoff applied
  // when the previous polls errored. Pure: pass `random` to make it
  // deterministic in a test.
  function nextPollDelayMs(opts) {
    const o = opts || {};
    const baseMs = typeof o.baseMs === "number" && o.baseMs > 0 ? o.baseMs : POLL_BASE_MS;
    const random = typeof o.random === "function" ? o.random : Math.random;
    const streak = clampStreak(o.errorStreak);

    // Backoff FIRST, then cap, then jitter -- so the jitter band is applied to
    // the capped value and the ceiling in the comment above is the real
    // ceiling rather than a value the jitter can push past.
    const backedOff = baseMs * Math.pow(BACKOFF_FACTOR, streak);
    const capped = Math.min(backedOff, BACKOFF_MAX_MS);
    return Math.round(capped * (JITTER_MIN_FACTOR + JITTER_SPAN * random()));
  }

  // Arm the next poll, or refuse to when the tab is backgrounded.
  //
  // Returns the timer handle, or null when nothing was armed. The REFUSAL is
  // the point: it does not arm a long timer while hidden, it arms nothing at
  // all, and resumption is driven by the visibilitychange handler instead. A
  // hidden tab therefore costs the studio nothing, which is what lets a load
  // run shed load rather than only add it.
  function armPoll(opts) {
    const o = opts || {};
    if (o.hidden) return null;
    const setTimer = typeof o.setTimer === "function" ? o.setTimer : setTimeout;
    const delay = nextPollDelayMs(o);
    return setTimer(o.run, delay);
  }

  return {
    POLL_BASE_MS,
    JITTER_MIN_FACTOR,
    JITTER_SPAN,
    BACKOFF_FACTOR,
    BACKOFF_MAX_MS,
    nextPollDelayMs,
    armPoll,
  };
});
