// Pure helpers for the finish-degrade projection (cf#118). No DOM: unit-tested under
// plain Node (tests/finish-degrade.test.ts) and loaded as a classic <script> as
// `window.finishDegrade`. Same UMD-ish shape as hook-availability-checks.js /
// cast-select.js / model-catalog.js. No framework, no build step.
//
// THE PROBLEM THIS EXISTS FOR (cf#118):
// When the video-finish tier is unavailable (VIDEO_FINISH_URL unbound, the hosted-tenant
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

  // cf#595 / core#226 / cf#853: THE SHARED `{ degraded, reasons }` PARSE.
  //
  // This started as the clip-finish parser and is now the parser for every stage that
  // speaks this vocabulary: `output.finish` (clip polish chain, core#226) and
  // `output.speech` / `output.master` / `output.dialogue` (core#317). One shape, so this is
  // a parse per stage and NOT a parser per stage -- four near-copies of this function is
  // how the shapes drift apart, and the copy that is least exercised is the one that rots.
  //
  // `degraded` IS THE COUNT AND `reasons` IS DEDUPED, so `degraded >= reasons.length` and
  // the two are not interchangeable. Measured against core#317's own test: two shots
  // failing for the SAME reason plus one clean shot yields
  // `{ degraded: 2, reasons: ["<one reason>"] }`. Anything deriving the count from
  // `reasons.length` under-reports exactly when several shots fail the same way, which is
  // the common case. The `reasons.length` fallback below fires only when `degraded` is
  // absent or unusable, i.e. on a payload that predates the field.
  function parseStageDegrade(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var n =
      typeof raw.degraded === "number" && Number.isFinite(raw.degraded) && raw.degraded >= 0
        ? Math.floor(raw.degraded)
        : null;
    var reasons = [];
    if (raw.reasons !== undefined) {
      if (!Array.isArray(raw.reasons)) return null;
      for (var i = 0; i < raw.reasons.length; i++) {
        if (isNonEmptyString(raw.reasons[i])) reasons.push(String(raw.reasons[i]).trim());
      }
    }
    if (n === null && reasons.length === 0) return null;
    return { degraded: n !== null ? n : reasons.length, reasons: reasons };
  }

  // cf#853: THE LADDER, and why it is three states and not two.
  //
  //   key ABSENT       the stage was never reached. NOT MEASURED. Show nothing.
  //   degraded: 0      it ran and ran clean. Measured, and NOT a limit.
  //   degraded: n > 0  it ran and degraded; `reasons` are the studio's own words.
  //
  // Absent and `degraded: 0` are DIFFERENT and the core pays to keep them different: it
  // omits the key entirely rather than writing a zero (core#317 `speechDegradeView` returns
  // undefined when `job.speech_shots` is absent). A parse that reads a missing key as a
  // clean run throws away the one distinction the core is spending a field to preserve,
  // and rebuilds cf#549 one stage over. That is why absent maps to "unmeasured" here and
  // never to "none-reported".
  //
  // The band vocabulary is UNCHANGED (cf#549's four bands), because the ladder IS that
  // vocabulary with a third rung for the malformed case.
  // cf#860: `film_finish` is the SAME LADDER IN A DIFFERENT SHAPE, so it joins this list through
  // an adapter rather than a fourth parser. Core emits it as
  // `{ applied, adopted, degraded: string | null }` (film-model.js filmFinishView), where a
  // non-empty `degraded` string is the one reason, `null` means the chain ran and applied
  // cleanly, and the whole object is `null` when the chain was never reached.
  //
  // This is the unfinished half of cf#549, which was filed about exactly this case: a film that
  // ships without its title card being indistinguishable from one that shipped complete.
  var STAGE_KEYS = ["speech", "master", "dialogue", "film_finish"];

  /** Tolerant string-list read for the STRUCTURAL ledgers (`applied` / `adopted`). Deliberately
   *  forgiving where the degrade parse is strict: a malformed ledger must not decide the band,
   *  because the band is a statement about the DEGRADE and nothing else. */
  function stringList(v) {
    var out = [];
    if (!Array.isArray(v)) return out;
    for (var i = 0; i < v.length; i++) {
      if (isNonEmptyString(v[i])) out.push(String(v[i]).trim());
    }
    return out;
  }

  /** `film_finish` -> the shared `{ degraded, reasons }` form, carrying its two ledgers.
   *
   *  STRICT ON THE DEGRADE KEY ON PURPOSE. A `degraded` key that is absent entirely is
   *  UNREADABLE, not clean: core always emits the key (null when clean), so a payload missing it
   *  is a shape we do not recognise, and reading an unrecognised shape as "ran clean" is the one
   *  direction this projection must never fail in. `null` present IS clean. */
  function parseFilmFinish(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (!Object.prototype.hasOwnProperty.call(raw, "degraded")) return null;
    // fc#1662: `adopted` counts the RECOVERED re-encodes -- steps whose artifact was found in R2
    // rather than run. It is the wasted-work signal and it is NOT a degrade; it is carried here so
    // a later surface can show it without re-deriving it, and it must never affect the band.
    var ledgers = { applied: stringList(raw.applied), adopted: stringList(raw.adopted) };
    var d = raw.degraded;
    if (d === null) return { degraded: 0, reasons: [], applied: ledgers.applied, adopted: ledgers.adopted };
    if (!isNonEmptyString(d)) return null;
    return { degraded: 1, reasons: [String(d).trim()], applied: ledgers.applied, adopted: ledgers.adopted };
  }

  // OUR structural noun for each stage, and the raw-shape parser it needs. Never a paraphrase of
  // a reason: the reasons are rendered verbatim beside this, never instead of it.
  var STAGE_LABELS = {
    speech: { noun: "speech cleanup", unit: "shot" },
    master: { noun: "audio master", unit: "step" },
    dialogue: { noun: "dialogue", unit: "stage" },
    film_finish: { noun: "title cards and captions", unit: "pass", parse: parseFilmFinish },
  };

  /** The raw-shape parser for a stage: its own, or the shared `{ degraded, reasons }` one. */
  function stageParser(key) {
    var label = STAGE_LABELS[key];
    return (label && label.parse) || parseStageDegrade;
  }

  /** Live-view parse for one stage: a degrade to SHOW, or null. Clean and junk both null,
   *  the same one-directional forgiveness degradeFrom() uses -- a parse failure must never
   *  tell a user their good film is broken. stageBand() is the wider projection. */
  function stageFrom(output, key) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    if (!key || !Object.prototype.hasOwnProperty.call(STAGE_LABELS, key)) return null;
    var parsed = stageParser(key)(output[key]);
    if (!parsed) return null;
    if (parsed.degraded <= 0 && parsed.reasons.length === 0) return null;
    var info = { stage: key, degraded: parsed.degraded, reasons: parsed.reasons };
    // Structural ledgers ride along when the shape carries them. They are not degrades.
    if (parsed.applied) info.applied = parsed.applied;
    if (parsed.adopted) info.adopted = parsed.adopted;
    return info;
  }

  /** The four-band projection for one stage, implementing the ladder above. */
  function stageBand(output, key) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return BAND_UNMEASURED;
    if (!key || !Object.prototype.hasOwnProperty.call(STAGE_LABELS, key)) return BAND_UNMEASURED;
    var raw = output[key];
    // Absent: the stage was never reached. This is the rung that must not collapse.
    if (raw === null || raw === undefined) return BAND_UNMEASURED;
    var parsed = stageParser(key)(raw);
    if (!parsed) return BAND_UNREADABLE;
    if (parsed.degraded <= 0 && parsed.reasons.length === 0) return BAND_NONE_REPORTED;
    return BAND_REPORTED;
  }

  /** OUR sentence for a stage degrade, structural only. The reasons follow it verbatim. */
  function stageSummary(info) {
    if (!info || !info.stage) return null;
    var label = STAGE_LABELS[info.stage];
    if (!label) return null;
    var n = info.degraded > 0 ? info.degraded : (info.reasons ? info.reasons.length : 0);
    if (!n) return null;
    if (info.stage === "film_finish") {
      // Always exactly one reason (core carries a single `degraded` string), so a count here
      // would read as false precision. "uncarded" is core's own word for this state.
      return "The title-card and caption pass degraded, so this film shipped without part of it.";
    }
    if (info.stage === "dialogue") {
      // core#317: the post-clips leg has exactly ONE declared degrade, so n is always 1
      // here and a count would read as false precision. Every other dialogue failure now
      // FAILS the render (core#314 / cf#834) rather than shipping as a limit.
      return "The dialogue stage did not run, so this film shipped without generated voices.";
    }
    return (
      "The " + label.noun + " ran with limits on " + n + " " + label.unit +
      (n === 1 ? "" : "s") + "."
    );
  }

  // cf#853: THE COMBINING RULE, AND IT IS DELIBERATELY NOT WORST-OF.
  //
  // Collapsing several signals to their worst band destroys the fact this whole vocabulary
  // exists to carry. A row whose assemble/mux signal is "none-reported" while its speech
  // signal is "unmeasured" is PARTIALLY measured, which is its own fact and is not the same
  // as either neighbour; folding it into one label is the exact collapse cf#549 named.
  //
  // So this returns the COMPOSITION, not a verdict. Callers take what they need:
  // `limited` is the only boolean here, and it is deliberately narrow -- it answers "did
  // any signal REPORT a limit", never "is this film complete", because no set of these
  // signals can answer the second question.
  /** The badge for a set of REPORTED stage degrades, or null when none reported.
   *
   *  Deliberately separate from bandNote(): that one says "the finishing step degraded",
   *  which is true for assemble/mux and false for speech, master and dialogue. A badge that
   *  names the wrong stage sends the reader to the wrong place, so these get their own
   *  wording and the stage names come from the payload rather than from a guess. */
  function stagesNote(infos) {
    var list = Array.isArray(infos) ? infos : [];
    var names = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && STAGE_LABELS[list[i].stage]) names.push(STAGE_LABELS[list[i].stage].noun);
    }
    if (!names.length) return null;
    return {
      label: names.length === 1 ? names[0] + " limited" : "stages limited",
      title:
        "this render completed, and these stages delivered less than a full pass: " +
        names.join(", ") +
        ". Expand the row for the studio own words on each.",
    };
  }

  function combineBands(bands) {
    var counts = { reported: 0, unreadable: 0, noneReported: 0, unmeasured: 0 };
    var list = Array.isArray(bands) ? bands : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] === BAND_REPORTED) counts.reported++;
      else if (list[i] === BAND_UNREADABLE) counts.unreadable++;
      else if (list[i] === BAND_NONE_REPORTED) counts.noneReported++;
      else counts.unmeasured++;
    }
    return {
      reported: counts.reported,
      unreadable: counts.unreadable,
      noneReported: counts.noneReported,
      unmeasured: counts.unmeasured,
      total: list.length,
      // Any signal that REPORTED a limit. Not "worst band": an unreadable signal is not a
      // reported limit and must not light the badge as though the studio had named one.
      limited: counts.reported > 0,
      // True only when every signal was measurable. This is the fact worst-of would erase.
      fullyMeasured: list.length > 0 && counts.unmeasured === 0 && counts.unreadable === 0,
    };
  }

  // Live-view parse: a degrade to SHOW, or null. Clean (degraded:0) and junk both null,
  // same one-directional forgiveness as degradeFrom -- a parse failure must not scare
  // a good film. clipFinishBand is the wider history projection.
  function clipFinishFrom(output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    var parsed = parseStageDegrade(output.finish);
    if (!parsed) return null;
    if (parsed.degraded <= 0 && parsed.reasons.length === 0) return null;
    return parsed;
  }

  function clipFinishBand(output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return BAND_UNMEASURED;
    if (output.finish === null || output.finish === undefined) return BAND_UNMEASURED;
    var parsed = parseStageDegrade(output.finish);
    if (!parsed) return BAND_UNREADABLE;
    if (parsed.degraded <= 0 && parsed.reasons.length === 0) return BAND_NONE_REPORTED;
    return BAND_REPORTED;
  }

  // Structural sentence, then the reasons VERBATIM. Never rewrite a reason into
  // `passthrough:backend-soft-degrade` -- that collapse is the defect.
  function clipFinishSummary(clip) {
    if (!clip || (clip.degraded <= 0 && (!clip.reasons || clip.reasons.length === 0))) return null;
    var n = clip.degraded || (clip.reasons ? clip.reasons.length : 0);
    return n === 1
      ? "One shot finished with limits (the polish step passed the clip through)."
      : n + " shots finished with limits (the polish step passed those clips through).";
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
    clipFinishFrom: clipFinishFrom,
    clipFinishBand: clipFinishBand,
    clipFinishSummary: clipFinishSummary,
    STAGE_KEYS: STAGE_KEYS,
    stageFrom: stageFrom,
    stageBand: stageBand,
    stageSummary: stageSummary,
    stagesNote: stagesNote,
    parseFilmFinish: parseFilmFinish,
    combineBands: combineBands,
  };
});
