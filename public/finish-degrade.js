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

  // cf#549: THE BAND -- what render history has to be able to COUNT.
  //
  // `degradeFrom()` above answers exactly ONE question ("is there a degrade to render?")
  // and is deliberately null for BOTH "no degrade" and "junk", because on the LIVE render
  // view a parse failure must never tell a user their good film is broken. That
  // one-directional forgiveness is correct there and it is NOT sufficient here: a null
  // that means three different things is precisely the defect cf#549 is about. So this is
  // a SECOND, wider projection over the SAME field. `degradeFrom` is untouched and still
  // owns the parse; nothing below re-implements it.
  //
  // FOUR BANDS, never two:
  //   "unmeasured"    -- no readable output payload on this row, so nothing can be said.
  //   "none-reported" -- payload readable; it reports no finishing degrade.
  //   "unreadable"    -- the payload REPORTED something and it could not be read.
  //   "reported"      -- a degrade, normalized by degradeFrom().
  //
  // "none-reported" IS NOT "the film is complete", and no caller may render it as one. It
  // means one thing: this payload reports no assemble/mux soft-degrade. Title cards and
  // subtitles degrade through `film_finish.degraded`, which vivijure-core#203 would put on
  // this same `output` object and WHICH DOES NOT EXIST TODAY -- so that entire class of
  // degradation is outside what this function can see, in every band, on every row. A
  // caller that reads "none-reported" as a clean verdict rebuilds cf#549 one field over.
  //
  // WHEN #203 LANDS it is a SECOND signal in this same vocabulary and needs no redesign:
  // a second per-signal band function plus a combining rule, with the band names and the
  // row's `data-finish-degrade` contract unchanged. The combining rule must NOT be
  // worst-of: a row whose assemble/mux signal is "none-reported" while its film_finish
  // signal is "unmeasured" is PARTIALLY measured, which is its own fact, and folding that
  // into either neighbour is the same collapse this band vocabulary exists to prevent.
  var BAND_UNMEASURED = "unmeasured";
  var BAND_NONE_REPORTED = "none-reported";
  var BAND_UNREADABLE = "unreadable";
  var BAND_REPORTED = "reported";

  function degradeBand(output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return BAND_UNMEASURED;
    var raw = output.finish_unavailable;
    // The orchestrator writes this key ONLY when it degrades, so absent-or-null on a
    // payload we could read is a real report of "no degrade at this step" rather than a
    // silence we have to guess about.
    if (raw === null || raw === undefined) return BAND_NONE_REPORTED;
    if (degradeFrom(output)) return BAND_REPORTED;
    // Present and unreadable. degradeFrom() forgives this to null for the live view; here
    // it gets its own band, because "the studio said something we could not read" and
    // "the studio said nothing" are different facts, and only one of them needs a human.
    return BAND_UNREADABLE;
  }

  // The visible tell for a band, or null for the bands that must render nothing.
  //
  // Only the two bands that need a human are badged. "unmeasured" is the ordinary state of
  // every in-flight row and "none-reported" the ordinary state of every finished one, so
  // badging either would fire on a healthy list, and a badge that fires on healthy rows is
  // a badge people learn to ignore. Both are still asserted POSITIVELY on every row
  // through `data-finish-degrade`, so all four states stay distinguishable to anything
  // counting them without putting four badges on a clean page.
  function bandNote(band) {
    if (band === BAND_REPORTED) {
      return {
        label: "finished with limits",
        title:
          "the finishing step degraded on this render: it delivered less than a full finish. Expand the row for what was delivered and why.",
      };
    }
    if (band === BAND_UNREADABLE) {
      return {
        label: "degrade unreadable",
        title:
          "this render reported a finishing limit and the report could not be read. Treat what was delivered as unknown; the raw payload is on the render panel under view.",
      };
    }
    return null;
  }

  return {
    NO_REASON: NO_REASON,
    DEGRADE_BANDS: {
      UNMEASURED: BAND_UNMEASURED,
      NONE_REPORTED: BAND_NONE_REPORTED,
      UNREADABLE: BAND_UNREADABLE,
      REPORTED: BAND_REPORTED,
    },
    bandNote: bandNote,
    clipsFrom: clipsFrom,
    degradeBand: degradeBand,
    degradeFrom: degradeFrom,
    deliverable: deliverable,
    deliveredSummary: deliveredSummary,
  };
});
