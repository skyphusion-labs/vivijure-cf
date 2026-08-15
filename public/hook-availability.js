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
// HOW A CONTROL OPTS IN: it declares its relationship to a key the host may report.
// There are THREE declarations, and the difference between them is the difference
// between honest and dishonest gating (cf#229 / cf#234).
//
//   REQUIRED   <button id="planner-plan" data-hook="plan.enhance">plan</button>
//              "I cannot run at all without this." -> disabled, with the reason.
//
//   ADVISORY   <details data-hook-advisory="capability:video-finish"> ... </details>
//              "I run fine; my PRODUCT cannot be delivered without this." -> never
//              disabled, carries the reason as a note. cf#229: a music-bed generator on
//              a studio with no video-finish tier produces a real bed that simply cannot
//              be muxed onto a film. Disabling it would hide capability that works, which
//              is cf#98's own defect pointed the other way.
//
//   CONTAINER  <details data-hook="master" data-hook-scope="container"> ... </details>
//              A required declaration on a SECTION rather than a control: disables every
//              form control inside it and emits ONE note (cf#234 option (b)). This is what
//              lets renderModuleSection gate a whole projected module panel generically,
//              with no per-hook branch and nothing hardcoded about which hooks exist.
//
// That is the entire contract. A hook or capability added next year needs one
// attribute, not a new gate, not a new branch here, and not a new UI story.
(function () {
  "use strict";

  var checks = window.hookAvailabilityChecks;
  var NOTE_CLASS = "hook-unavailable-note";
  var ADVISORY_NOTE_CLASS = "hook-advisory-note";
  var DISABLED_MARK = "hookGateDisabled"; // dataset key: only WE re-enable what WE disabled
  var TITLE_MARK = "hookGateTitled"; // dataset key: only WE clear a title WE wrote
  var CONTAINER_SEL = '[data-hook-scope="container"]';
  var FORM_SEL = "select, button, input, textarea";

  var map = {};
  // cf#580: reads the SHARED per-page memo instead of its own request.
  //
  // The registryUnavailable() branch is NOT decoration, and it is why cf#344 added that flag. load()
  // never rejects, so a failed read arrives here as the documented empty shape -- byte-identical to a
  // studio that genuinely restricts nothing. Without the flag this gate would run apply() over the
  // document on a failed read, which the pre-cf#580 catch never did. The flag keeps the two apart, so
  // behaviour is preserved exactly rather than approximately.
  var ready = window.moduleRegistry.load()
    .then(function (d) {
      if (window.moduleRegistry.registryUnavailable()) {
        // A failed registry read means we do not KNOW of any restriction. It must not
        // black out a studio that is probably fine; the individual routes still fail
        // honestly on their own if they are not.
        map = {};
        return map;
      }
      map = checks ? checks.unavailableHooks(d) : {};
      apply(document);
      return map;
    });

  function isFormControl(el) {
    var tag = (el.tagName || "").toLowerCase();
    return tag === "select" || tag === "button" || tag === "input" || tag === "textarea";
  }

  function isContainer(el) {
    return el.getAttribute("data-hook-scope") === "container";
  }

  // True when the element sits inside a container this gate has currently disabled. Guards
  // the re-enable path: querySelectorAll walks parents before children, so a descendant
  // whose OWN hook is available would otherwise undo the container's disable one loop
  // iteration later.
  function insideGatedContainer(el) {
    if (!el.parentElement || !el.parentElement.closest) return false;
    return !!el.parentElement.closest(CONTAINER_SEL + ".hook-unavailable");
  }

  function noteFor(el, cls) {
    var next = el.nextElementSibling;
    if (next && next.classList && next.classList.contains(cls)) return next;
    return null;
  }

  function writeNote(el, cls, reason) {
    var note = noteFor(el, cls);
    if (!note) {
      note = document.createElement("p");
      note.className = cls;
      note.setAttribute("role", "note");
      if (el.parentNode) el.parentNode.insertBefore(note, el.nextSibling);
    }
    note.textContent = reason;
  }

  function dropNote(el, cls) {
    var note = noteFor(el, cls);
    if (note && note.parentNode) note.parentNode.removeChild(note);
  }

  function disableControl(el) {
    // Only record the mark if WE are the ones disabling it, so a control disabled
    // for an unrelated reason (readonly gate, an empty project list) is never
    // silently re-enabled by us later.
    if (!el.disabled) {
      el.disabled = true;
      el.dataset[DISABLED_MARK] = "1";
    }
  }

  function enableControl(el) {
    if (el.dataset[DISABLED_MARK] === "1") {
      el.disabled = false;
      delete el.dataset[DISABLED_MARK];
    }
  }

  function setOwnedTitle(el, reason) {
    // Only overwrite a title we own. Several planner controls ship a hand-written
    // title explaining what they do; clobbering it permanently would destroy real
    // information to display a condition that may well clear on the next poll.
    if (!el.title || el.dataset[TITLE_MARK] === "1") {
      el.title = reason;
      el.dataset[TITLE_MARK] = "1";
    }
  }

  function clearOwnedTitle(el) {
    if (el.dataset[TITLE_MARK] === "1") {
      el.removeAttribute("title");
      delete el.dataset[TITLE_MARK];
    }
  }

  function markUnavailable(el, reason) {
    if (isFormControl(el)) disableControl(el);
    el.setAttribute("aria-disabled", "true");
    el.classList.add("hook-unavailable");
    // The reason belongs on the control for a pointer user AND in text for everyone
    // else. A tooltip alone is not an honest disclosure.
    setOwnedTitle(el, reason);
    // CONTAINER mode (cf#234): one declaration covers a whole projected section. Every
    // form control inside goes disabled -- a section that only DIMS still lets a user
    // type a title card that will never be rendered -- and the section carries ONE note
    // rather than N (tagging every generated input was option (c), and it buries the
    // panel in repeated sentences).
    if (isContainer(el)) {
      var kids = el.querySelectorAll(FORM_SEL);
      for (var i = 0; i < kids.length; i++) disableControl(kids[i]);
    }
    writeNote(el, NOTE_CLASS, reason);
  }

  function clearUnavailable(el) {
    if (isFormControl(el) && !insideGatedContainer(el)) enableControl(el);
    el.removeAttribute("aria-disabled");
    el.classList.remove("hook-unavailable");
    // Same ownership rule in reverse: only clear the title if the gate set it.
    clearOwnedTitle(el);
    if (isContainer(el)) {
      var kids = el.querySelectorAll(FORM_SEL);
      for (var i = 0; i < kids.length; i++) enableControl(kids[i]);
    }
    dropNote(el, NOTE_CLASS);
  }

  // ADVISORY (cf#229): the control WORKS. Say what it cannot deliver, disable nothing.
  // No aria-disabled and no .hook-unavailable dimming either: this is information, and
  // dressing a working control up as a dead one is the same lie in softer clothes.
  function markAdvisory(el, reason) {
    el.classList.add("hook-advisory");
    writeNote(el, ADVISORY_NOTE_CLASS, reason);
  }

  function clearAdvisory(el) {
    el.classList.remove("hook-advisory");
    dropNote(el, ADVISORY_NOTE_CLASS);
  }

  // Apply the current determination to every declared control under `root`. Safe to
  // call repeatedly: controls rendered later (the planner builds several pickers
  // after load) just call apply() again.
  function apply(root) {
    if (!checks) return;
    var scope = root && root.querySelectorAll ? root : document;
    var els = scope.querySelectorAll("[data-hook], [data-hook-advisory]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var required = el.getAttribute("data-hook");
      var reason = required ? checks.reasonFor(map, required) : null;
      if (reason) markUnavailable(el, reason);
      else clearUnavailable(el);
      // A control can declare both. When the REQUIRED key is already unavailable the
      // control is disabled and stating a second limitation underneath it adds noise
      // about a step the user cannot reach anyway.
      var advisoryKey = el.getAttribute("data-hook-advisory");
      var advisory = !reason && advisoryKey ? checks.reasonFor(map, advisoryKey) : null;
      if (advisory) markAdvisory(el, advisory);
      else clearAdvisory(el);
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
