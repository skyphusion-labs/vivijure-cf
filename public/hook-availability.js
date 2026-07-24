// Vivijure studio -- hook availability gate (cf#98). A GATE, not a feature, exactly
// like readonly-gate.js: no nav entry, no page of its own. It is a PROJECTION of the
// registry, never a hardcoded per-feature availability check. The sole signal is
// host.hooks_unavailable on GET /api/modules (the core describing ITSELF, sibling of
// host.dispatch and host.readonly). On a deploy that does not report it, the map is
// empty and this shim is completely inert.
//
// WHY (cf#98): a hosted tenant studio provisioned without the AI binding / GATEWAY_ID
// still has the plan.enhance module INSTALLED, so the planning-model picker filled
// with options whose every choice 500s at hPlan. Installed is not servable. Rather
// than teach the planner one special case about AI bindings, the core reports what it
// cannot serve and every control that drives that hook goes honest at once.
//
// HOW A CONTROL OPTS IN: it declares the hook it drives.
//     <select id="planner-model" data-hook="plan.enhance">
//     <button id="planner-plan" data-hook="plan.enhance">plan</button>
// That is the entire contract. A hook added next year needs one attribute, not a new
// gate, not a new branch here, and not a new UI story.
(function () {
  "use strict";

  var checks = window.hookAvailabilityChecks;
  var NOTE_CLASS = "hook-unavailable-note";
  var DISABLED_MARK = "hookGateDisabled"; // dataset key: only WE re-enable what WE disabled
  var TITLE_MARK = "hookGateTitled"; // dataset key: only WE clear a title WE wrote

  var map = {};
  var ready = fetch("/api/modules")
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (d) {
      map = checks ? checks.unavailableHooks(d) : {};
      apply(document);
      return map;
    })
    .catch(function () {
      // A failed registry read means we do not KNOW of any restriction. It must not
      // black out a studio that is probably fine; the individual routes still fail
      // honestly on their own if they are not.
      map = {};
      return map;
    });

  function isFormControl(el) {
    var tag = (el.tagName || "").toLowerCase();
    return tag === "select" || tag === "button" || tag === "input" || tag === "textarea";
  }

  function noteFor(el) {
    var next = el.nextElementSibling;
    if (next && next.classList && next.classList.contains(NOTE_CLASS)) return next;
    return null;
  }

  function markUnavailable(el, reason) {
    if (isFormControl(el)) {
      // Only record the mark if WE are the ones disabling it, so a control disabled
      // for an unrelated reason (readonly gate, an empty project list) is never
      // silently re-enabled by us later.
      if (!el.disabled) {
        el.disabled = true;
        el.dataset[DISABLED_MARK] = "1";
      }
    }
    el.setAttribute("aria-disabled", "true");
    el.classList.add("hook-unavailable");
    // The reason belongs on the control for a pointer user AND in text for everyone
    // else. A tooltip alone is not an honest disclosure.
    //
    // Only overwrite a title we own. Several planner controls ship a hand-written
    // title explaining what they do; clobbering it permanently would destroy real
    // information to display a condition that may well clear on the next poll.
    if (!el.title || el.dataset[TITLE_MARK] === "1") {
      el.title = reason;
      el.dataset[TITLE_MARK] = "1";
    }

    var note = noteFor(el);
    if (!note) {
      note = document.createElement("p");
      note.className = NOTE_CLASS;
      note.setAttribute("role", "note");
      if (el.parentNode) el.parentNode.insertBefore(note, el.nextSibling);
    }
    note.textContent = reason;
  }

  function clearUnavailable(el) {
    if (isFormControl(el) && el.dataset[DISABLED_MARK] === "1") {
      el.disabled = false;
      delete el.dataset[DISABLED_MARK];
    }
    el.removeAttribute("aria-disabled");
    el.classList.remove("hook-unavailable");
    // Same ownership rule in reverse: only clear the title if the gate set it.
    if (el.dataset[TITLE_MARK] === "1") {
      el.removeAttribute("title");
      delete el.dataset[TITLE_MARK];
    }
    var note = noteFor(el);
    if (note && note.parentNode) note.parentNode.removeChild(note);
  }

  // Apply the current determination to every declared control under `root`. Safe to
  // call repeatedly: controls rendered later (the planner builds several pickers
  // after load) just call apply() again.
  function apply(root) {
    if (!checks) return;
    var scope = root && root.querySelectorAll ? root : document;
    var els = scope.querySelectorAll("[data-hook]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var hook = el.getAttribute("data-hook");
      var reason = checks.reasonFor(map, hook);
      if (reason) markUnavailable(el, reason);
      else clearUnavailable(el);
    }
  }

  window.hookAvailability = {
    ready: ready,
    apply: apply,
    isUnavailable: function (hook) {
      return checks ? checks.isUnavailable(map, hook) : false;
    },
    reasonFor: function (hook) {
      return checks ? checks.reasonFor(map, hook) : null;
    },
    unavailableList: function () {
      return checks ? checks.unavailableList(map) : [];
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      apply(document);
    });
  } else {
    apply(document);
  }
})();
