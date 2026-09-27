// THE ONE PLACE A STAGE DEGRADE BECOMES DOM (cf#864).
//
// WHY THIS FILE EXISTS. cf#859 wired the per-stage degrade signals into two surfaces, the live
// render view (planner-render.js renderDegradeNote) and render history (planner-history-row.js
// buildHistoryRow), and it did so by writing the SAME block-building loop twice. That is the
// copy-forks-at-copy-time shape: two loops that must agree forever, with nothing asserting they do,
// and the one that is looked at less often is the one that drifts. Both call this now.
//
// IT IS ALSO WHAT MADE THE RENDERING TESTABLE. The two host functions cannot be unit-called:
// buildHistoryRow is ~980 lines and reaches ~40 helpers declared in sibling planner files, and
// renderDegradeNote resolves live DOM through `$()`. So the DECIDING was fully tested (74 cases in
// tests/finish-degrade.test.ts) while nothing asserted that any of it reached the screen. Pulling
// the DOM construction into one pure function gives it exactly one un-stubbable seam and a real
// test, instead of a grep asserting that a call site exists.
//
// NO DOM API IS TOUCHED AT LOAD TIME and `document` is a PARAMETER, not a global read. That is what
// lets tests/stage-degrade-view.test.ts drive it under plain Node with a small element stub, the same
// way finish-degrade.js is tested -- and the same reason: a projection whose correctness matters in
// the negative direction has to be checkable without a browser.
//
// THE NEGATIVE DIRECTION IS THE POINT. A clean stage and a stage that was never reached must render
// NOTHING. A badge or a block that appears on a healthy render is worse than none, because people
// learn to ignore it and then it reads as coverage. `stageBlocks` therefore returns an EMPTY ARRAY
// for those, and the caller appends nothing -- and because it returns the elements rather than
// appending them itself, a test can prove the difference is this function's decision rather than an
// unreached code path.
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.stageDegradeView = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  /**
   * Build one block per REPORTED stage degrade.
   *
   * @param doc        anything with createElement(tag) -> element. Injected, never read off a global.
   * @param infos      the stage infos from finishDegrade.stageFrom(), already filtered to reported.
   * @param summarize  stageSummary from finish-degrade.js. Injected so this file holds no parse and
   *                   no wording of its own: OUR structural sentence lives in one place.
   * @param opts       { className, role } -- the two surfaces style their notes differently and that
   *                   stays explicit, so sharing the builder cannot silently restyle either one.
   * @returns          an array of elements, EMPTY when there is nothing to report.
   */
  function stageBlocks(doc, infos, summarize, opts) {
    var out = [];
    if (!doc || typeof doc.createElement !== "function") return out;
    if (!Array.isArray(infos) || !infos.length) return out;
    var o = opts || {};
    for (var i = 0; i < infos.length; i++) {
      var info = infos[i];
      // A junk entry is skipped rather than failing the whole list: one malformed stage must not
      // hide the stages that DID report. Same rule clipsFrom() uses in finish-degrade.js.
      if (!info || typeof info !== "object" || !info.stage) continue;
      var reasons = Array.isArray(info.reasons) ? info.reasons : [];
      var summary = typeof summarize === "function" ? summarize(info) : null;
      // Nothing to say and nothing to quote: emit no empty shell.
      if (!summary && !reasons.length) continue;
      var wrap = doc.createElement("div");
      if (o.className) wrap.className = o.className;
      if (o.role && typeof wrap.setAttribute === "function") wrap.setAttribute("role", o.role);
      if (typeof wrap.setAttribute === "function") wrap.setAttribute("data-stage", info.stage);
      if (summary) {
        var p = doc.createElement("p");
        p.className = "render-degrade-summary";
        p.textContent = summary;
        wrap.appendChild(p);
      }
      // VERBATIM. The studio wrote the truest available description of what it could not do;
      // rewriting it here would lose the information the reader needs.
      for (var j = 0; j < reasons.length; j++) {
        var why = doc.createElement("p");
        why.className = "render-degrade-reason";
        why.textContent = reasons[j];
        wrap.appendChild(why);
      }
      out.push(wrap);
    }
    return out;
  }

  /**
   * Every stage this payload REPORTS a degrade for, in declared stage order.
   *
   * THIS IS HERE RATHER THAN IN EACH CONSUMER ON PURPOSE, and not only to avoid a third copy.
   * The acceptance question for cf#864 is "does a CLEAN or NEVER-REACHED stage render nothing",
   * and that claim spans the enumeration AND the building: stageBlocks() alone can only ever be
   * handed already-reported stages, so asserting it returns nothing for an empty list is
   * trivially true and proves nothing about a clean payload. With the enumeration here, a test
   * can drive a RAW payload end to end and watch the negative direction actually hold.
   *
   * @param output the render output payload.
   * @param fd     finishDegrade. Injected, so this file holds no parse of its own.
   */
  function reportedStages(output, fd) {
    var out = [];
    if (!fd || !Array.isArray(fd.STAGE_KEYS) || typeof fd.stageFrom !== "function") return out;
    for (var i = 0; i < fd.STAGE_KEYS.length; i++) {
      var info = fd.stageFrom(output, fd.STAGE_KEYS[i]);
      // stageFrom is null for BOTH "ran clean" and "never reached", which is exactly the filter
      // this projection needs: neither is a limit and neither may render.
      if (info) out.push(info);
    }
    return out;
  }

  /** The whole pipeline: raw payload -> the blocks to append. Empty for a clean or unmeasured film. */
  function stageBlocksFor(doc, output, fd, opts) {
    return stageBlocks(doc, reportedStages(output, fd), fd && fd.stageSummary, opts);
  }

  return {
    stageBlocks: stageBlocks,
    reportedStages: reportedStages,
    stageBlocksFor: stageBlocksFor,
  };
});
