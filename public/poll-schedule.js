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

  // ---------------------------------------------------------------------------
  // cf#581 / cf#573: the LIFECYCLE half of the policy.
  //
  // PR #563 gave the render poll jitter, backoff and a visibility pause. PR #575
  // gave jitter and backoff to the remaining five loops and DELIBERATELY stopped
  // there, because a pause needs a matching RESUME per loop, and a pause without a
  // correct resume is worse than the defect it fixes: the user backgrounds the tab,
  // the poll never re-arms, and the UI sits on "pending" forever for work that
  // actually completed. That hazard is real precisely because these loops watch
  // USER-INITIATED jobs (a LoRA training run, a music generation, a shot regen),
  // not a background refresh nobody is waiting on.
  //
  // So the resume cannot be a per-file afterthought bolted onto three files in
  // three shapes. It has to be part of the primitive, which is what createLoop is.
  // A loop created here owns its timer, its error streak and its paused flag, and
  // registers itself with the ONE visibilitychange listener this module attaches
  // per document. Pause and resume are therefore properties of the MECHANISM
  // rather than of whoever remembered to wire them up.
  //
  // WHY isActive IS REQUIRED RATHER THAN DEFAULTED. Resume must not restart a loop
  // whose job finished while the tab was hidden, and pause must not mark a finished
  // loop as paused, because it would then resume on the next visibility change and
  // poll a terminal job. Only the caller can answer "is there still something in
  // flight", so the predicate is supplied and createLoop refuses without one. A
  // default of "always active" would be the silent-fallback shape that reads as
  // working, the same reason pollPolicy() throws instead of falling back to a flat
  // interval.
  //
  // WHY THE DOCUMENT IS INJECTED. The policy above touches no DOM on purpose so it
  // unit-tests under plain Node. The same must hold here or the resume path is
  // untestable, and cf#581 says in as many words that the resume assertion is the
  // one that matters and must be driven red first. A test passes a fake document
  // carrying a hidden flag and an addEventListener, drives visibilitychange in both
  // directions, and watches the loop stop and then start. A resume that cannot be
  // observed is a resume nobody has seen.
  //
  // WHY THERE IS AN ATTEMPT CAP. cf#573: the regen loop re-armed on its .catch()
  // path with no cap, so a persistently failing route was polled forever by every
  // open tab. Backoff bounds the RATE; only a cap bounds the TOTAL. It is opt-in
  // because a cap on a legitimately long job is a different defect.

  // Documents this module has already attached its listener to. Keyed by the
  // document object itself, so a test document and the real one coexist, and a
  // second createLoop on the same page does not attach a second listener. Two
  // listeners would call pause twice, which is harmless, and resume twice, which
  // is not: resume runs the poll body immediately.
  const attachedDocs = new Set();

  // Every live loop. Membership is what the visibility listener iterates, and
  // stop() removes a loop, so a finished job can never be resumed by a later
  // visibility change.
  const liveLoops = new Set();

  function defaultDoc() {
    return typeof document !== "undefined" ? document : null;
  }

  function attachVisibility(doc) {
    if (!doc || typeof doc.addEventListener !== "function") return;
    if (attachedDocs.has(doc)) return;
    attachedDocs.add(doc);
    doc.addEventListener("visibilitychange", function () {
      const hidden = doc.hidden === true;
      // Snapshot before iterating: resume() runs the poll body synchronously, and
      // a poll body is allowed to stop its own loop, which mutates liveLoops
      // mid-iteration.
      const snapshot = [];
      liveLoops.forEach(function (loop) {
        if (loop.doc === doc) snapshot.push(loop);
      });
      for (let i = 0; i < snapshot.length; i++) {
        if (hidden) snapshot[i].pause();
        else snapshot[i].resume();
      }
    });
  }

  function createLoop(opts) {
    const o = opts || {};
    if (typeof o.run !== "function") {
      throw new Error("createLoop needs a run function");
    }
    if (typeof o.isActive !== "function") {
      throw new Error(
        "createLoop needs an isActive predicate (cf#581: resume must not restart a finished job)",
      );
    }
    const doc = o.doc !== undefined ? o.doc : defaultDoc();
    const setTimer = typeof o.setTimer === "function" ? o.setTimer : setTimeout;
    const clearTimer = typeof o.clearTimer === "function" ? o.clearTimer : clearTimeout;
    const maxErrorStreak =
      typeof o.maxErrorStreak === "number" && o.maxErrorStreak > 0
        ? Math.floor(o.maxErrorStreak)
        : 0;
    const onGiveUp = typeof o.onGiveUp === "function" ? o.onGiveUp : null;

    let timer = null;
    let paused = false;
    let errorStreak = 0;
    let gaveUp = false;

    function clear() {
      if (timer !== null && timer !== undefined) clearTimer(timer);
      timer = null;
    }

    function hidden() {
      return !!(doc && doc.hidden === true);
    }

    const loop = {
      doc: doc,

      // Arm the next tick. Returns the timer handle, or null when nothing was
      // armed. Null has two causes and they are NOT the same state: the tab is
      // hidden (paused, resumable) or the job is done (not active, never
      // resumed). state() distinguishes them; an absence check cannot.
      arm: function () {
        clear();
        if (gaveUp || !o.isActive()) {
          paused = false;
          return null;
        }
        timer = armPoll({
          hidden: hidden(),
          baseMs: o.baseMs,
          errorStreak: errorStreak,
          random: o.random,
          setTimer: setTimer,
          run: o.run,
        });
        paused = timer === null;
        return timer;
      },

      // Re-arm after a FAILED poll: bump the streak, back off, and give up once
      // the cap is reached. Returns the timer handle or null.
      armAfterError: function () {
        errorStreak += 1;
        if (maxErrorStreak > 0 && errorStreak >= maxErrorStreak) {
          gaveUp = true;
          clear();
          paused = false;
          if (onGiveUp) onGiveUp(errorStreak);
          return null;
        }
        return loop.arm();
      },

      // Re-arm after a GOOD poll: a successful poll clears the backoff, so a
      // studio that had a bad minute is watched at full cadence again.
      armAfterSuccess: function () {
        errorStreak = 0;
        return loop.arm();
      },

      // Stop arming while the tab is hidden. Marks the loop PAUSED rather than
      // stopped, but only while the job is still in flight, so the resume below
      // has something to distinguish.
      pause: function () {
        clear();
        paused = !gaveUp && o.isActive();
        return paused;
      },

      // Resume with an IMMEDIATE poll rather than a fresh delay, so a tab hidden
      // for ten minutes shows current state at once instead of after another
      // interval. Mirrors resumeRenderPoll in planner-render.js, which is the
      // model cf#581 names. Returns true when it actually resumed, so a test can
      // assert the RESUME and not merely the absence of a poll.
      resume: function () {
        if (!paused || gaveUp || !o.isActive()) return false;
        paused = false;
        o.run();
        return true;
      },

      // The job finished. Clears the timer and the backoff, and clears PAUSED so a
      // later visibility change cannot resume a terminal job. Registration is kept
      // on purpose: the same loop object is re-armed when the next job of the same
      // kind starts (the LoRA pane polls one character at a time through one loop),
      // and a loop that quietly unregistered itself on stop would come back armed
      // but no longer pausable, which is the silent half-working state this whole
      // change exists to remove. isActive() is what makes a stopped loop inert.
      stop: function () {
        clear();
        paused = false;
        errorStreak = 0;
      },

      // Tear the loop down for good. Use this for loops created PER JOB rather than
      // per pane (the regen poll creates one per regen key), so the registry does
      // not grow without bound over a long session. After destroy the loop is
      // unregistered and no visibility change can reach it.
      destroy: function () {
        clear();
        paused = false;
        errorStreak = 0;
        liveLoops.delete(loop);
      },

      state: function () {
        return {
          armed: timer !== null && timer !== undefined,
          paused: paused,
          errorStreak: errorStreak,
          gaveUp: gaveUp,
        };
      },
    };

    liveLoops.add(loop);
    attachVisibility(doc);
    return loop;
  }

  // Test seam: how many loops are registered against a given document. Lets a
  // test prove that stop() actually unregisters, which is the difference between
  // a loop that cannot be resumed and one that merely was not.
  function registeredLoopCount(doc) {
    let n = 0;
    liveLoops.forEach(function (loop) {
      if (loop.doc === doc) n += 1;
    });
    return n;
  }

  return {
    POLL_BASE_MS,
    JITTER_MIN_FACTOR,
    JITTER_SPAN,
    BACKOFF_FACTOR,
    BACKOFF_MAX_MS,
    nextPollDelayMs,
    armPoll,
    createLoop,
    registeredLoopCount,
  };
});
