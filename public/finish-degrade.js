// Pure helpers for the finish-degrade projection (cf#118). No DOM: unit-tested under
// plain Node (tests/finish-degrade.test.ts) and loaded as a classic <script> as
// `window.finishDegrade`. Same UMD-ish shape as hook-availability-checks.js /
// cast-select.js / model-catalog.js. No framework, no build step.
//
// THE PROBLEM THIS EXISTS FOR (cf#118):
// When the video-finish tier is unavailable (VIDEO_FINISH_VPC unbound, the hosted-tenant
// case), the orchestrator degrades HONESTLY rather than failing: it ships the per-shot
// clips at assemble, or the silent film at mux, and says so. The poll payload has carried
// that fact all along, `output.finish_unavailable {at, reason, delivered}` plus
// `output.clips` (core film-render-bridge.js), and the panel dropped it on the floor. The
// user saw a green "completed" and a JSON blob.
//
// Worse, the assemble degrade sets `output_key` to UNDEFINED (core film-output-key.js:
// `delivered === "clips"` -> undefined), and the old completed-branch only touched the
// download anchors INSIDE `if (typeof out.output_key === "string")`. Nothing ever reset
// them. So a degraded render following a successful one in the same session left
// "download silent MP4" pointing at the PREVIOUS render film: the wrong artifact,
// presented as this render output. That is the opposite of an honest degrade, and it is
// why `deliverable()` below returns a decision for ALL THREE cases rather than a boolean.
//
// Deliberately generic about the reason: the studio wrote the truest available description
// of why the step is dead, and this file renders it VERBATIM. It never rewrites, prettifies
// or softens it. `deliveredSummary()` states only what WE know STRUCTURALLY (which step,
// what was handed over) and is displayed BESIDE the verbatim reason, never instead of it.
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.finishDegrade = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Used when the studio reports a degrade but gives no readable reason. We still disclose
  // that the finishing step did not run; we just cannot say why, and we say THAT rather
  // than inventing a cause.
  var NO_REASON =
    "This studio could not run the finishing step, and it did not say why. Nothing you do here will fix it; tell whoever runs this studio.";

  function isNonEmptyString(v) {
    return typeof v === "string" && v.trim().length > 0;
  }

  // Every clip the payload names, as {shot_id, key}. A junk entry is skipped rather than
  // failing the whole list: one malformed clip must not hide the clips that ARE deliverable.
  function clipsFrom(output) {
    var raw = output && output.clips;
    var out = [];
    if (!Array.isArray(raw)) return out;
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (!c || typeof c !== "object") continue;
      if (!isNonEmptyString(c.shot_id) || !isNonEmptyString(c.key)) continue;
      out.push({ shot_id: c.shot_id.trim(), key: c.key.trim() });
    }
    return out;
  }

  // Normalize `output.finish_unavailable` into a plain object, or null for "no degrade".
  //
  // Total and forgiving in ONE direction only: junk anywhere resolves to "nothing to
  // report" (null), never to a scary banner on a render that is perfectly fine. A parse
  // failure must not tell a user their good film is broken.
  function degradeFrom(output) {
    if (!output || typeof output !== "object") return null;
    var raw = output.finish_unavailable;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var at = isNonEmptyString(raw.at) ? raw.at.trim() : null;
    var delivered = isNonEmptyString(raw.delivered) ? raw.delivered.trim() : null;
    // A degrade object carrying neither structural fact is indistinguishable from junk.
    // Report nothing rather than a contentless warning.
    if (!at && !delivered) return null;
    return {
      at: at,
      delivered: delivered,
      reason: isNonEmptyString(raw.reason) ? raw.reason.trim() : NO_REASON,
      clips: clipsFrom(output),
    };
  }

  // THE single decision the UI needs: what, concretely, can this person download?
  //   "film"  -> one assembled artifact at .key (the normal path, and the mux degrade,
  //              which still produces a complete silent video).
  //   "clips" -> no assembled film; the per-shot clips in .clips ARE the delivered render.
  //   "none"  -> nothing downloadable was named. The links must be CLEARED, not left
  //              pointing at whatever they pointed at last.
  function deliverable(output) {
    var degrade = degradeFrom(output);
    var key = output && isNonEmptyString(output.output_key) ? output.output_key.trim() : null;
    if (key) return { kind: "film", key: key, clips: degrade ? degrade.clips : [] };
    var clips = degrade ? degrade.clips : [];
    if (clips.length) return { kind: "clips", key: null, clips: clips };
    return { kind: "none", key: null, clips: [] };
  }

  // What the studio actually handed over, stated structurally. This is OUR sentence, built
  // from the two enum fields; it is never a paraphrase of the operator reason, which is
  // rendered verbatim alongside it.
  function deliveredSummary(degrade) {
    if (!degrade) return null;
    var where =
      degrade.at === "mux"
        ? "The audio mux step"
        : degrade.at === "assemble"
          ? "The assemble step"
          : "The finishing step";
    if (degrade.delivered === "clips") {
      var n = degrade.clips.length;
      var what = n ? n + " per-shot clip" + (n === 1 ? "" : "s") : "the per-shot clips";
      return where + " did not run, so this render delivered " + what + " instead of one assembled film.";
    }
    if (degrade.delivered === "silent_film") {
      return where + " did not run, so this render delivered the SILENT film: the video is complete, the audio was never mixed onto it.";
    }
    return where + " did not run, so part of the finishing pass is missing from this render.";
  }

  return {
    NO_REASON: NO_REASON,
    clipsFrom: clipsFrom,
    degradeFrom: degradeFrom,
    deliverable: deliverable,
    deliveredSummary: deliveredSummary,
  };
});
