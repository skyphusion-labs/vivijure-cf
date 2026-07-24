// Pure helpers for the hook-availability projection (cf#98). No DOM: unit-tested
// under plain Node (tests/hook-availability-checks.test.ts) and loaded as a classic
// <script> as `window.hookAvailabilityChecks`. Same UMD-ish shape as
// cast-select.js / model-catalog.js. No framework, no build step.
//
// THE PROBLEM THIS EXISTS FOR (cf#98):
// GET /api/storyboard/models is projected from the INSTALLED plan.enhance modules
// (src/planning-models.ts). Installed is not the same as SERVABLE: a hosted tenant
// studio provisioned without the `AI` binding and `GATEWAY_ID` still has the module
// installed, so the picker fills with models whose every option 500s at hPlan. The
// panel was not lying on purpose; the payload simply never carried the fact.
//
// The fix is a payload fact, projected: the core reports which hooks it cannot
// serve and why, on the SAME `host` block that already carries `dispatch` and
// `readonly` (the core describing itself). This file normalizes that report.
//
// Deliberately GENERIC. Nothing here knows what plan.enhance is, or mentions AI,
// GATEWAY_ID, or the planner. A hook added next year is honest for free, with no
// change to this file and no new per-feature UI branch. That is the whole point:
// the alternative is a hardcoded planner-availability check that the NEXT hook
// then has to reinvent.
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.hookAvailabilityChecks = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Used when the host says a hook is unavailable but gives no readable reason.
  // We still refuse to advertise the control; we just cannot say why, and we say
  // THAT rather than inventing a cause.
  var NO_REASON =
    "This studio cannot run this step right now, and it did not say why. Nothing you do here will fix it; tell whoever runs this studio.";

  function isNonEmptyString(v) {
    return typeof v === "string" && v.trim().length > 0;
  }

  // Normalize `host.hooks_unavailable` into a plain { hook: reason } map.
  //
  // Total and forgiving in ONE direction only: junk anywhere resolves to "no
  // restriction" (an empty map), never to "everything is broken". A parse failure
  // must not black out a working studio. The opposite bias would be worse than the
  // bug this fixes.
  //
  // A deploy that does not report the field at all (every deploy today) yields an
  // empty map, so this whole projection is INERT until the core starts reporting.
  function unavailableHooks(payload) {
    var out = {};
    if (!payload || typeof payload !== "object") return out;
    var host = payload.host;
    if (!host || typeof host !== "object") return out;
    var raw = host.hooks_unavailable;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.keys(raw).forEach(function (hook) {
      if (!isNonEmptyString(hook)) return;
      var reason = raw[hook];
      out[hook] = isNonEmptyString(reason) ? reason.trim() : NO_REASON;
    });
    return out;
  }

  function isUnavailable(map, hook) {
    return !!(map && isNonEmptyString(hook) && Object.prototype.hasOwnProperty.call(map, hook));
  }

  // The operator-authored reason, returned VERBATIM. This file does not rewrite,
  // prettify, or soften it: whoever runs the studio wrote the truest available
  // description of why the step is dead, and paraphrasing it loses information the
  // person reading it needs.
  function reasonFor(map, hook) {
    return isUnavailable(map, hook) ? map[hook] : null;
  }

  // Every hook the host reported as unservable, sorted for stable rendering.
  function unavailableList(map) {
    if (!map) return [];
    return Object.keys(map)
      .sort()
      .map(function (hook) {
        return { hook: hook, reason: map[hook] };
      });
  }

  return {
    NO_REASON: NO_REASON,
    unavailableHooks: unavailableHooks,
    isUnavailable: isUnavailable,
    reasonFor: reasonFor,
    unavailableList: unavailableList,
  };
});
