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
// COLD START vs STALL (cf#303): the snapshot only exists once the GPU worker
// is actually running. Before that a worker is being started and a large model
// set loaded, so the keyframe band legitimately sits at its floor with no
// sub-signal to subdivide on. We do NOT fabricate motion there. Instead the
// panel explains the wait in words (COLD_START_NOTE below). workersMin is 0 on
// every endpoint by a deliberate standing cost ruling, so cold start is a
// permanent accepted characteristic to be EXPLAINED, not engineered away.
//
// The queue-versus-running signal now exists (cf#307, core 1.15+): the film
// poll view sets status IN_QUEUE when the module reports wait=accepted, and
// the direct RunPod path carries delayTimeMs. The panel must READ those
// fields. Inferring startup from "keyframe and nothing drawn yet" cannot
// tell a spinning-up worker from a running encode that has not landed a
// frame, which is the same failure class this issue names. Filmmaker copy
// never dumps IN_QUEUE raw; statusLabel translates it.
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

  // Split a full poll view ({ status, delayTimeMs, output }) from a bare
  // output bag ({ phase, progress, ... }). Callers used to pass only
  // data.output, which dropped the IN_QUEUE / delayTime signal.
  function pollParts(poll) {
    if (!poll || typeof poll !== "object") {
      return { status: "", delayTimeMs: null, out: null };
    }
    const hasStatus = typeof poll.status === "string" && poll.status.length > 0;
    const nested = poll.output && typeof poll.output === "object" ? poll.output : null;
    const out = hasStatus && nested ? nested : poll;
    let delayTimeMs = null;
    if (typeof poll.delayTimeMs === "number" && poll.delayTimeMs > 0) {
      delayTimeMs = poll.delayTimeMs;
    } else if (typeof poll.delayTime === "number" && poll.delayTime > 0) {
      delayTimeMs = poll.delayTime;
    }
    return { status: hasStatus ? poll.status : "", delayTimeMs, out };
  }

  // The server-authored stall verdict, already carried in the envelope by
  // stallSignal(). Accepts a full poll or a bare output bag.
  function isStalled(poll) {
    if (!poll || typeof poll !== "object") return false;
    if (poll.stalled === true) return true;
    if (poll.output && typeof poll.output === "object" && poll.output.stalled === true) {
      return true;
    }
    return false;
  }

  // True when the door says the worker is still starting: IN_QUEUE,
  // SUBMITTED, backend_wait=accepted, or a positive delayTime that is not
  // attached to an already-running encode. delayTime on IN_PROGRESS is
  // historical queue wait, not a live cold start.
  function isColdStart(poll) {
    if (!poll || typeof poll !== "object") return false;
    if (isStalled(poll)) return false;
    const parts = pollParts(poll);
    if (parts.status === "IN_QUEUE" || parts.status === "SUBMITTED") return true;
    if (parts.out && parts.out.backend_wait === "accepted") return true;
    if (
      parts.delayTimeMs &&
      parts.status !== "IN_PROGRESS" &&
      parts.status !== "COMPLETED" &&
      parts.status !== "FAILED" &&
      parts.status !== "CANCELLED" &&
      parts.status !== "TIMED_OUT" &&
      parts.status !== "SCATTERING"
    ) {
      return true;
    }
    return false;
  }

  // cf#303: the startup window. Prefer the observed queue signal (IN_QUEUE /
  // delayTime / backend_wait=accepted). Fall back to "keyframe with nothing
  // drawn" only when the poll has no status, so a running encode that has
  // not landed a frame is NOT called a cold start.
  function isStartupWindow(poll) {
    if (!poll || typeof poll !== "object") return false;
    if (isStalled(poll)) return false;
    if (isColdStart(poll)) return true;
    const parts = pollParts(poll);
    if (parts.status === "IN_PROGRESS" || (parts.out && parts.out.backend_wait === "running")) {
      return false;
    }
    if (parts.status) return false;
    const out = parts.out;
    if (!out || typeof out !== "object") return false;
    const phase = typeof out.phase === "string" ? out.phase.toLowerCase() : "";
    if (phase !== "keyframe" && phase !== "shards") return false;
    if (typeof out.progress === "number" && out.progress > 0) return false;
    if (typeof out.scene_index === "number" && out.scene_index > 1) return false;
    return true;
  }

  // The words the live panel shows. One note, mutually exclusive: stall
  // wins, then cold start, else nothing (a running encode has no note).
  function waitCopy(poll) {
    if (isStalled(poll)) return STALL_NOTE;
    if (isStartupWindow(poll)) return COLD_START_NOTE;
    return null;
  }

  // Filmmaker-facing status words. Raw tokens stay available as the
  // element's title; the visible text is never IN_QUEUE / IN_PROGRESS.
  const STATUS_LABELS = {
    IN_QUEUE: "Starting up",
    SUBMITTED: "Starting up",
    IN_PROGRESS: "Rendering",
    SCATTERING: "Rendering",
    COMPLETED: "Done",
    FAILED: "Failed",
    CANCELLED: "Cancelled",
    TIMED_OUT: "Timed out",
  };

  function statusLabel(status) {
    if (typeof status !== "string" || !status) return null;
    if (Object.prototype.hasOwnProperty.call(STATUS_LABELS, status)) {
      return STATUS_LABELS[status];
    }
    return status;
  }

  return {
    PIPELINE_PHASES,
    PHASE_LABELS,
    STATUS_LABELS,
    COLD_START_NOTE,
    STALL_NOTE,
    phaseLabel,
    statusLabel,
    isStartupWindow,
    isColdStart,
    isStalled,
    waitCopy,
    MIN_FRACTION_FOR_ETA,
    MIN_ELAPSED_MS_FOR_ETA,
    progressFraction,
    remainingMs,
  };
});
