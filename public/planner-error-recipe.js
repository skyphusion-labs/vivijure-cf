// Pure helpers for mapped planner failure recipes (cf#649). No DOM: unit-tested
// under plain Node (tests/planner-error-recipe.test.ts) and loaded as a classic
// <script> as `window.plannerErrorRecipe`. Same UMD-ish shape as finish-degrade.js.
//
// THE PROBLEM THIS EXISTS FOR (cf#649):
// A failed render used to paste provider JSON (7003, 3030, Unsupported field)
// as the first line the filmmaker saw. They could not tell what to change.
// A failed film is a recipe: one sentence, then the raw payload behind a fold.
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.plannerErrorRecipe = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var KEYFRAMES_MSG =
    "This motion model rejected the still. Retry, or switch to Seedance.";
  var FLAGGED_MSG =
    "The image filter blocked this shot. Rewrite the prompt or swap the keyframe.";
  var FINISH_DOOR_MSG =
    "We could not finish this film (the finish door is down). Retry in a bit.";
  var UNKNOWN_MSG = "This render failed.";

  function stringifyError(raw) {
    if (raw == null) return "";
    if (typeof raw === "string") return raw;
    try {
      return JSON.stringify(raw);
    } catch (err) {
      return String(raw);
    }
  }

  function classifyError(text) {
    var s = String(text || "");
    var lower = s.toLowerCase();
    if (
      /\b7003\b/.test(s)
      || /unsupported field/i.test(s)
      || /invalid value at keyframes/i.test(s)
    ) {
      return "keyframes";
    }
    if (
      /\b3030\b/.test(s)
      || lower.indexOf("flagged") >= 0
      || lower.indexOf("privacyinformation") >= 0
      || /real person/i.test(s)
    ) {
      return "flagged";
    }
    // Infra only. Do not put CSAM / policy refusals on this path; those stay
    // unknown so the raw refusal is the first line the filmmaker sees.
    if (
      /video-finish URL not configured|finish url not configured|hooks_unavailable/i.test(s)
    ) {
      return "finish_door";
    }
    return "unknown";
  }

  function firstHumanLine(text) {
    var s = String(text || "").trim();
    if (!s) return UNKNOWN_MSG;
    var lead = s.charAt(0);
    if (lead === "{" || lead === "[") {
      try {
        var obj = JSON.parse(s);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          var msg = obj.error || obj.message || obj.msg;
          if (typeof msg === "string" && msg.trim()) return msg.trim();
        }
      } catch (err) {
        // not JSON; fall through to the first line
      }
    }
    var line = s.split(/\r?\n/)[0].trim();
    if (line.length > 180) line = line.slice(0, 177) + "...";
    return line || UNKNOWN_MSG;
  }

  function recipeFromError(raw) {
    var text = stringifyError(raw);
    var kind = classifyError(text);
    if (kind === "keyframes") {
      return { kind: kind, message: KEYFRAMES_MSG, raw: text };
    }
    if (kind === "flagged") {
      return { kind: kind, message: FLAGGED_MSG, raw: text };
    }
    if (kind === "finish_door") {
      return { kind: kind, message: FINISH_DOOR_MSG, raw: text };
    }
    var human = firstHumanLine(text);
    return { kind: "unknown", message: human, raw: text };
  }

  return {
    KEYFRAMES_MSG: KEYFRAMES_MSG,
    FLAGGED_MSG: FLAGGED_MSG,
    FINISH_DOOR_MSG: FINISH_DOOR_MSG,
    UNKNOWN_MSG: UNKNOWN_MSG,
    stringifyError: stringifyError,
    classifyError: classifyError,
    firstHumanLine: firstHumanLine,
    recipeFromError: recipeFromError,
  };
});
