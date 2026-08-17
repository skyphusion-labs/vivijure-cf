// Pure render-progress + ETA helpers for the planner render page (#115).
//
// These have NO DOM access on purpose: they unit-test under plain Node
// (tests/render-eta.test.ts) and also load as a classic <script> on
// planner.html, exposing `window.renderEta`. The UMD-ish wrapper picks
// CommonJS when `module` exists (the test harness) and a global otherwise
// (the browser), so the same file serves both with no build step (mirrors
// lora-preflight.js).
//
// Why this exists: the render-status poll envelope (filmJobToPollView ->
// phaseProgress in src/film-render-bridge.ts) only carries a `progress`
// float during the i2v (clips) phase. The keyframe phase pins scene_index
// to 1 (so the old scene-count fraction was 0 the whole phase), and the
// finish / assemble / mux phases carry no per-unit signal at all -- so the
// old computeProgressFraction returned null for big stretches and the UI sat
// at "?%  eta computing..." for the whole render (issue #115, screenshot).
//
// The fix maps the known pipeline phases onto cumulative progress BANDS so the
// overall fraction is defined (never null) for every in-flight phase and never
// runs backwards: the bar reads overall pipeline completion, not just the
// current phase, and the ETA can extrapolate from it. Within a band we use the
// best signal the envelope offers (a real `progress` float, else completed-
// scene count); when a phase has no sub-signal we sit at the band floor, which
// is honest about "phase N of 5 underway" without fabricating motion.
//
// KEYFRAME SUB-PROGRESS: wired since #318. readKeyframeDone
// (src/render-progress.ts) reads the GPU job's R2 progress snapshot and feeds
// keyframe_done into the poll view, so the keyframe band now subdivides on a
// real signal. The older note here called that channel "unwired"; that is no
// longer true, and this comment is corrected rather than left to mislead.
//
// REMAINING HONEST GAP (cf#303): the snapshot only exists once the GPU worker
// is actually running. Before that a worker is being started and a large model
// set loaded, so the keyframe band legitimately sits at its floor with no
// sub-signal to subdivide on. We do NOT fabricate motion there. Instead the
// panel explains the wait in words (COLD_START_NOTE below). workersMin is 0 on
// every endpoint by a deliberate standing cost ruling, so cold start is a
// permanent accepted characteristic to be EXPLAINED, not engineered away.
//
// WHAT WE DELIBERATELY DO NOT CLAIM: we do not say "queued at RunPod". The
// module /poll contract (core PollResponse) reports only `pending: true`, with
// no queued-versus-running distinction, and modules hold their own backend
// creds so the host cannot ask RunPod directly. Asserting queue state would be
// claiming an observation we cannot make. What we CAN say honestly is that the
// pipeline is in its startup window, and, via the server-authored `stalled`
// signal already in the envelope, when it has stopped being one.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.renderEta = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Cumulative progress bands, in pipeline order. start + span per phase; the
  // spans sum to 1. i2v (video generation) is the heaviest GPU phase, so it
  // owns the widest band; finish / assemble / mux are comparatively cheap. The
  // phase keys match the `phase` strings the backend poll view emits
  // (src/film-render-bridge.ts phaseProgress: keyframe / i2v / finish /
  // assemble / mux).
  const PIPELINE_PHASES = [
    { key: "keyframe", start: 0.0, span: 0.35 },
    { key: "i2v", start: 0.35, span: 0.5 },
    { key: "shards", start: 0.0, span: 0.85 },
    { key: "finish", start: 0.85, span: 0.08 },
    { key: "gather", start: 0.85, span: 0.08 },
    { key: "finishing", start: 0.85, span: 0.08 },
    { key: "assemble", start: 0.93, span: 0.05 },
    { key: "mux", start: 0.98, span: 0.02 },
  ];

  // cf#303: user-facing names for the internal phase tokens. The envelope's
  // `phase` strings (keyframe / i2v / mux) are pipeline vocabulary, not
  // English; shown raw they read as jargon to a first-time user. An unknown
  // phase deliberately falls back to the RAW token rather than being hidden, so
  // a new backend phase degrades to "visible but unpolished" instead of
  // "silently missing" -- the same failure class this module already guards.
  const PHASE_LABELS = {
    // "queued" is not an envelope phase (core emits no `phase` key before
    // submission); it arrives via the poll view's statusRaw, which the panel
    // falls back to so the pre-submit window is not blank either.
    queued: "Waiting to start",
    keyframe: "Drawing keyframes",
    i2v: "Animating shots",
    shards: "Animating shots",
    finish: "Finishing shots",
    gather: "Putting the film together",
    finishing: "Putting the film together",
    assemble: "Putting the film together",
    mux: "Adding audio",
  };

  // cf#303: what the panel says while a worker is starting. Filmmaker-facing:
  // name the wait, do not lecture about GPU economics or name the vendor.
  // Kept here (not in the DOM layer) so it is single-sourced and unit-testable.
  const COLD_START_NOTE =
    "Starting up. The first minutes are the model coming online, then frames appear.";

  // cf#303: shown when the server's own stall signal fires (the envelope's
  // `stalled` flag, authored by the orchestrator past KEYFRAME_STALL_SECONDS).
  // This is the other half of telling the two states apart: the startup note
  // must STOP being shown once the wait stops being normal, or it would
  // reassure the user through exactly the failure it was meant to disambiguate.
  const STALL_NOTE =
    "This render has not advanced in a while and may need attention.";

  // ETA confidence floors: below this much overall progress, or this little
  // elapsed wall time, a linear extrapolation is dominated by one-time model-
  // load cost and produces wild over-estimates, so we withhold a number and let
  // the caller show "computing..." instead of scaring the user.
  const MIN_FRACTION_FOR_ETA = 0.03;
  const MIN_ELAPSED_MS_FOR_ETA = 10000;

  function clamp01(x) {
    if (typeof x !== "number" || Number.isNaN(x)) return 0;
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  // Best within-phase fraction (0..1) from whatever the envelope carries: a
  // real `progress` float wins; else completed-scene count ((scene_index - 1) /
  // scene_total, scene_index is 1-based from the GPU); else 0 (band floor).
  function subFraction(out) {
    if (typeof out.progress === "number" && out.progress >= 0 && out.progress <= 1) {
      return out.progress;
    }
    if (
      typeof out.scene_index === "number" &&
      typeof out.scene_total === "number" &&
      out.scene_total > 0
    ) {
      return clamp01(Math.max(0, out.scene_index - 1) / out.scene_total);
    }
    return 0;
  }

  // Scan an out.log array from the end for the most recent "Scene N/M" counter
  // and return (N-1)/M. Legacy fallback for envelopes that stream progress as
  // log text rather than structured fields. Returns null when none is found.
  function fractionFromLog(out) {
    if (!Array.isArray(out.log)) return null;
    for (let i = out.log.length - 1; i >= 0; i--) {
      const m = String(out.log[i]).match(/Scene\s+(\d+)\s*\/\s*(\d+)/i);
      if (m) {
        const tot = parseInt(m[2], 10);
        if (tot > 0) return clamp01((parseInt(m[1], 10) - 1) / tot);
        return null;
      }
    }
    return null;
  }

  // Overall pipeline completion fraction (0..1) for a status-poll output
  // envelope, or null when no signal at all is available (the caller then shows
  // "?%" / an indeterminate bar). Phase-aware first (the film pipeline), with a
  // graceful fallback to the raw progress / scene-count / log signals for non-
  // film envelopes (e.g. scatter or a bare RunPod view).
  function progressFraction(out) {
    if (!out || typeof out !== "object") return null;
    const phase = typeof out.phase === "string" ? out.phase.toLowerCase() : null;
    if (phase) {
      const band = PIPELINE_PHASES.find((p) => p.key === phase);
      if (band) return clamp01(band.start + band.span * subFraction(out));
      // Unknown phase string -> fall through to the legacy signals below.
    }
    if (typeof out.progress === "number" && out.progress >= 0 && out.progress <= 1) {
      return out.progress;
    }
    if (
      typeof out.scene_index === "number" &&
      typeof out.scene_total === "number" &&
      out.scene_total > 0
    ) {
      return clamp01(Math.max(0, out.scene_index - 1) / out.scene_total);
    }
    return fractionFromLog(out);
  }

  // Estimated remaining time in ms via linear extrapolation from elapsed wall
  // time and the overall fraction, or null when we are not confident enough to
  // show a number yet (fraction/elapsed below the floors, or a non-positive
  // fraction). totalEst = elapsed / fraction; remaining = totalEst - elapsed.
  function remainingMs(fraction, elapsedMs) {
    if (typeof fraction !== "number" || Number.isNaN(fraction) || fraction <= 0) return null;
    if (typeof elapsedMs !== "number" || Number.isNaN(elapsedMs) || elapsedMs < 0) return null;
    if (fraction < MIN_FRACTION_FOR_ETA || elapsedMs < MIN_ELAPSED_MS_FOR_ETA) return null;
    const totalEstMs = elapsedMs / fraction;
    return Math.max(0, totalEstMs - elapsedMs);
  }

  // User-facing label for an envelope's phase string, or null when there is no
  // phase at all (the pre-submit window, where core's phaseProgress emits no
  // `phase` key). Unknown phases pass through raw. hasOwnProperty guards the
  // lookup so a phase named e.g. "constructor" cannot return an inherited
  // Object.prototype member instead of a label.
  function phaseLabel(phase) {
    if (typeof phase !== "string" || !phase) return null;
    const key = phase.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PHASE_LABELS, key)) return PHASE_LABELS[key];
    return phase;
  }

  // cf#303: the startup window -- the keyframe phase is underway but no keyframe
  // has landed yet, so the GPU is still being brought up. Bounded by the
  // server's stall signal: once `stalled` is set this is no longer a normal
  // startup and we must stop calling it one.
  //
  // This is an honest statement about OUR pipeline's position, not a claim
  // about RunPod's queue, which we cannot observe through the module contract.
  function isStartupWindow(out) {
    if (!out || typeof out !== "object") return false;
    if (out.stalled === true) return false;
    const phase = typeof out.phase === "string" ? out.phase.toLowerCase() : "";
    if (phase !== "keyframe" && phase !== "shards") return false;
    if (typeof out.progress === "number" && out.progress > 0) return false;
    if (typeof out.scene_index === "number" && out.scene_index > 1) return false;
    return true;
  }

  // The server-authored stall verdict, already carried in the envelope by
  // stallSignal() but until now surfaced only in the history list, never in the
  // live panel the user actually watches during the wait.
  function isStalled(out) {
    return !!out && typeof out === "object" && out.stalled === true;
  }

  return {
    PIPELINE_PHASES,
    PHASE_LABELS,
    COLD_START_NOTE,
    STALL_NOTE,
    phaseLabel,
    isStartupWindow,
    isStalled,
    MIN_FRACTION_FOR_ETA,
    MIN_ELAPSED_MS_FOR_ETA,
    progressFraction,
    remainingMs,
  };
});
