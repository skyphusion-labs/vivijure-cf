// Pure helpers for the finish-budget projection (cf#540). No DOM: unit-tested under plain Node
// (tests/finish-budget-checks.test.ts) and loaded as a classic <script> as
// `window.finishBudgetChecks`. Same UMD-ish shape as hook-availability-checks.js /
// abuse-link-checks.js / finish-degrade.js. No framework, no build step.
//
// THE PROBLEM THIS EXISTS FOR (cf#540):
// The planner admits a 60s shot. `SCENE_MAX_SECONDS = 60` lives in
// vivijure-core/src/storyboard-validate.ts:58 and its comment justifies 60 by Wan I2V motion
// cost. That reasoning is sound for what it covers. It is SILENT about finish cost, and the
// finish door has a budget of its own that a 60s shot cannot fit inside.
//
// Three constants, in three repositories, none referencing another:
//   FFMPEG_TIMEOUT             = 1200  -- vivijure-upscale/handler.py:85 (the door guard)
//   PHASE_HARD_DEADLINE_SECONDS= 5400  -- vivijure-core/src/film-model.ts:862 (per phase)
//   SCENE_MAX_SECONDS          = 60    -- vivijure-core/src/storyboard-validate.ts:58 (planner)
// Nothing asserts any relationship between them, which is how they came to disagree silently.
//
// THIS FILE INTRODUCES NO FOURTH CONSTANT. It carries no number at all. Every term in the
// ceiling comes from a module's own manifest, projected to the browser on GET /api/modules --
// which needs no serializer change, because registry.ts `toPublic` strips only `binding` and
// passes the whole manifest through. That is the point of the frontend being a projection: a
// module that declares its cost lights this up, and a module that does not is honestly UNKNOWN.
//
// WHY A REFUSAL AND NOT A CLAMP. A silent clamp produces a film the user did not ask for and
// did not consent to. A refusal before the GPU is booked is cheap; a job that dies at a door
// guard hours in is not. So over-budget is an ERROR that blocks the bundle, and it names the
// number, the chain that produced it, and the cause.
//
// WHY UNKNOWN ADMITS RATHER THAN REFUSES, argued rather than assumed. As of the commit that
// added this file, NO module manifest in this repo declares a finish cost, so a
// refuse-on-unknown rule would refuse one hundred percent of correct work on its first day.
// A guard that fires on correct work is the guard people switch off, and it would be switched
// off long before any manifest gained the field. The asymmetry settles it: a wrong REFUSAL
// costs the guard itself, while a wrong ADMIT costs one job that dies at the door guard, which
// is exactly today's behaviour and is recoverable. The sibling check in the core chose the same
// way for the same shape -- checkDurationGrid (preflight.ts) says "no declared grid -> no
// issues, absence is honest".
//
// BUT UNKNOWN IS NEVER SILENT. Silence about finish cost is the defect this issue is about, so
// admitting quietly would rebuild it. An underived ceiling reports ONE info line naming the
// modules that declare nothing -- once per render, not once per scene, so it informs without
// becoming the noise that trains a reader to ignore the panel.
//
// AND "COULD NOT ASK" IS NOT "NOTHING TO SAY". A registry that failed to load and a studio with
// no finish modules are byte-identical in an empty projection. They are different facts owned by
// different parties and they read differently to a user, so they get different states here.
// plannerRegistry.registryUnavailable() already draws that line (cf#344); this consumes it.
//
// DELIBERATELY GENERIC. Nothing here knows what an upscaler is, or mentions Real-ESRGAN, RunPod,
// or any module by name. A finish module added next year is honest for free.
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.finishBudgetChecks = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // The three states a chain ceiling can be in. A ceiling is a NUMBER only in "derived"; the
  // other two are absences with different owners, and collapsing them is the defect above.
  var DERIVED = "derived";
  var UNDECLARED = "undeclared";
  var UNAVAILABLE = "unavailable";

  function isModule(m) {
    return !!m && typeof m === "object" && typeof m.name === "string" && m.name !== "";
  }

  // A module's display name, matching plannerRegistry.moduleLabel: provides[0].label when the
  // manifest offers one, else the bare module id. Duplicated here rather than imported because
  // this file must stay DOM-free and loadable under plain Node for its tests; the fallback chain
  // is two lines and identical.
  function label(mod) {
    if (!isModule(mod)) return "";
    var l = mod.provides && mod.provides[0] && mod.provides[0].label;
    return (l && String(l).trim()) || mod.name;
  }

  // MIRROR of the core's selectForChain (vivijure-core/src/modules/render-pipeline.ts) for the
  // `finish` hook, and stated as a mirror on purpose.
  //
  //   selection absent or { mode: "default" } -- every serving module whose manifest does not say
  //                                              participation: "opt_in".
  //   { mode: "named", modules: [...] }       -- exactly those, in serving order. Naming a module
  //                                              IS the opt-in, so a named opt_in module runs.
  //                                              Naming overrides participation in the PERMISSIVE
  //                                              direction only, never the restrictive one.
  //
  // KNOWN LIMIT, stated here rather than discovered later. This is a second implementation of one
  // side of a cross-repo contract, so it can drift from the core's copy while every test in THIS
  // repo stays green, and no test here can observe that. The consequence is bounded: a drifted
  // mirror mis-derives a ceiling and therefore mis-refuses or mis-admits, it does not change what
  // actually runs. Closing it properly means a conformance test that consumes the core's own
  // definition rather than a transcription of it; that belongs with the core cap change, not here.
  //
  // The panel does not send a hook selection today -- there is no `select` key in
  // plannerRenderConfig.collect() -- so `selection` is undefined for every panel render and the
  // default arm is the live one. The named arm is written now so that a future selection control
  // needs no change here.
  function selectedFinishModules(serving, selection) {
    var mods = (serving || []).filter(isModule);
    if (selection && selection.mode === "named") {
      var wanted = Array.isArray(selection.modules) ? selection.modules : [];
      return mods.filter(function (m) { return wanted.indexOf(m.name) !== -1; });
    }
    return mods.filter(function (m) { return m.participation !== "opt_in"; });
  }

  // A finish_cost declaration, validated. Every field must be present and sane or the module
  // counts as declaring NOTHING -- a partial declaration is refused rather than defaulted,
  // because a default here would invent a ceiling the module never promised.
  function costOf(mod) {
    if (!isModule(mod)) return null;
    var c = mod.finish_cost;
    if (!c || typeof c !== "object") return null;
    var rate = c.seconds_per_second;
    var budget = c.budget_seconds;
    if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) return null;
    if (typeof budget !== "number" || !isFinite(budget) || budget <= 0) return null;
    return {
      rate: rate,
      budget: budget,
      // Provenance is OPTIONAL to declare and load-bearing when present. A rate measured on
      // hardware this render will not touch is not a rate for this render, and a dated
      // measurement quoted without its date becomes a claim about now.
      measuredOn: typeof c.measured_on === "string" && c.measured_on.trim() ? c.measured_on.trim() : null,
      measuredAt: typeof c.measured_at === "string" && c.measured_at.trim() ? c.measured_at.trim() : null,
    };
  }

  // The chain ceiling.
  //
  // Each selected module is guarded by its OWN door with its OWN budget, so a shot must fit every
  // one of them and the TIGHTEST wins. There is no margin term here and that is deliberate: a
  // margin constant in the panel would be the fourth constant this issue exists to prevent. A
  // module that wants headroom declares a smaller budget_seconds, which keeps the whole
  // relationship inside the declaration where it can be measured and reviewed.
  //
  // registryUnavailable is passed in rather than read, so this stays DOM-free and testable.
  function finishBudget(serving, selection, registryUnavailable) {
    var chain = selectedFinishModules(serving, selection);
    if (registryUnavailable) {
      return { state: UNAVAILABLE, maxSeconds: null, chain: chain, declared: [], undeclared: [] };
    }
    var declared = [];
    var undeclared = [];
    for (var i = 0; i < chain.length; i++) {
      var cost = costOf(chain[i]);
      if (cost) declared.push({ module: chain[i], cost: cost });
      else undeclared.push(chain[i]);
    }
    // An empty chain has nothing to constrain the shot, which is a real DERIVED answer of "this
    // render selects no finish work", not an absence. Its ceiling is null and it emits nothing.
    if (chain.length === 0) {
      return { state: DERIVED, maxSeconds: null, chain: chain, declared: [], undeclared: [] };
    }
    // One undeclared module makes the whole chain underivable. A ceiling computed from the
    // modules that DID declare would be an over-estimate presented as a limit, which is worse
    // than no number: it would admit shots the silent module cannot finish, with authority.
    if (undeclared.length > 0) {
      return { state: UNDECLARED, maxSeconds: null, chain: chain, declared: declared, undeclared: undeclared };
    }
    var tightest = null;
    for (var j = 0; j < declared.length; j++) {
      var d = declared[j];
      var secs = Math.floor((d.cost.budget / d.cost.rate) * 10) / 10;
      if (tightest === null || secs < tightest.maxSeconds) {
        tightest = { maxSeconds: secs, module: d.module, cost: d.cost };
      }
    }
    return {
      state: DERIVED,
      maxSeconds: tightest.maxSeconds,
      binding: tightest,
      chain: chain,
      declared: declared,
      undeclared: [],
    };
  }

  function chainNames(mods) {
    return (mods || []).map(label).join(", ");
  }

  // The provenance clause. Absent when the module declared none, so this never invents a
  // measurement or implies one that was not taken.
  function provenance(cost) {
    if (!cost) return "";
    var bits = [];
    if (cost.measuredOn) bits.push("measured on " + cost.measuredOn);
    if (cost.measuredAt) bits.push(cost.measuredOn ? "on " + cost.measuredAt : "measured " + cost.measuredAt);
    return bits.length ? " (" + bits.join(" ") + ")" : "";
  }

  function sceneId(scene, idx) {
    if (scene && typeof scene.id === "string" && scene.id.trim()) return scene.id.trim();
    return "scene_" + String(idx + 1).padStart(2, "0");
  }

  function plannedSeconds(scene, storyboard) {
    if (scene && typeof scene.target_seconds === "number") return scene.target_seconds;
    if (storyboard && typeof storyboard.clip_seconds === "number") return storyboard.clip_seconds;
    return undefined;
  }

  // Issues in the SAME shape the server preflight emits ({ level, scope, message }), so they merge
  // into the existing issue list and the existing error-gates-the-bundle rule with no new
  // rendering path and no parallel surface.
  function finishBudgetIssues(storyboard, budget) {
    var issues = [];
    if (!budget) return issues;

    if (budget.state === UNAVAILABLE) {
      issues.push({
        level: "info",
        scope: "finish",
        message:
          "The module registry did not load, so the permitted shot length could not be derived. "
          + "This is not a statement about what this studio has installed, and it is not a "
          + "statement that these shots will finish.",
      });
      return issues;
    }

    if (budget.state === UNDECLARED) {
      issues.push({
        level: "info",
        scope: "finish",
        message:
          "The permitted shot length cannot be derived for this render. The selected finish chain ("
          + chainNames(budget.chain) + ") includes " + chainNames(budget.undeclared)
          + ", which declares no finish cost, so there is no rate to divide the door budget by. "
          + "Shots are admitted at the planner cap and a long shot may still fail at the finish door.",
      });
      return issues;
    }

    if (budget.state !== DERIVED || budget.maxSeconds === null) return issues;

    var b = budget.binding;
    var scenes = storyboard && Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
    for (var i = 0; i < scenes.length; i++) {
      var planned = plannedSeconds(scenes[i], storyboard);
      if (typeof planned !== "number" || !(planned > 0)) continue;
      // The tolerance mirrors the core's duration-grid check so a shot planned exactly at the
      // ceiling is admitted rather than refused by a floating-point remainder.
      if (planned > budget.maxSeconds + 0.001) {
        issues.push({
          level: "error",
          scope: "scene[" + sceneId(scenes[i], i) + "]",
          message:
            sceneId(scenes[i], i) + " plans " + planned + "s, and the selected finish chain ("
            + chainNames(budget.chain) + ") finishes at most " + budget.maxSeconds
            + "s per shot. " + label(b.module) + " allows " + b.cost.budget
            + "s of finish work and costs " + b.cost.rate + "s per second of footage"
            + provenance(b.cost) + ". Shorten this shot to " + budget.maxSeconds
            + "s or less, or deselect that finish module. Rendering it as planned would book the "
            + "GPU and then fail at the finish door.",
        });
      }
    }
    return issues;
  }

  return {
    DERIVED: DERIVED,
    UNDECLARED: UNDECLARED,
    UNAVAILABLE: UNAVAILABLE,
    label: label,
    selectedFinishModules: selectedFinishModules,
    costOf: costOf,
    finishBudget: finishBudget,
    finishBudgetIssues: finishBudgetIssues,
  };
});
