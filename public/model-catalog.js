// Generic, catalog-driven hydration for every model <select> in the panel.
//
// cf#129: the model catalog is a PROJECTION of the installed modules, so every picker
// that renders it needs the same four states (loading / rows / honestly-empty / failed)
// and the same restore semantics. This file owns that logic ONCE. Before it existed the
// only correct implementation lived inside planner-plan.js loadModels(), and the three
// cast image pickers each open-coded a hardcoded array instead, which is precisely how
// the panel ended up trusting none of its backends.
//
// Deliberately picker-agnostic: it knows about rows and <select> elements, never about
// planning vs image vs a hook name. Callers supply the noun for the empty state and their
// own wording for a dropped selection, so no product copy is baked in here.
//
// Row shape (key-pinned with the backend, cf#129): { id, label, group, type, capabilities }.
// `group` is carried by the wire shape but not yet rendered as <optgroup>; see the note on
// renderRows below.
//
// Vanilla JS, classic <script>, no bundler, matching the planner.js / cast.js idiom.
// Load order matters: this file must come BEFORE any file that hydrates a picker.

var modelCatalog = (function () {
  "use strict";

  function addOption(select, value, text, disabled) {
    var opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    if (disabled) opt.disabled = true;
    select.appendChild(opt);
    return opt;
  }

  // The SELECTABLE ids in a picker: real projected models only. Placeholder options
  // (loading / empty / error) carry an empty value and are filtered out here, so a
  // placeholder-only picker is never mistaken for a loaded catalog.
  function realOptionIds(select) {
    return Array.from(select.options).map(function (o) { return String(o.value); }).filter(Boolean);
  }

  function renderLoading(select) {
    select.disabled = true;
    select.innerHTML = "<option>loading models...</option>";
  }

  // Build the picker from projected rows. Returns the id list so the caller can resolve a
  // restore against it.
  //
  // NOTE (gap, not a defect): rows carry `group`, and the ideal projection renders those as
  // <optgroup> labels rather than a flat list. Left flat here deliberately so this extraction
  // is behaviour-preserving; enabling grouping changes picker DOM and belongs with the phase-2
  // projection work, not smuggled into a refactor.
  function renderRows(select, rows) {
    select.innerHTML = "";
    for (var i = 0; i < rows.length; i++) {
      addOption(select, rows[i].id, rows[i].label || rows[i].id, false);
    }
    select.disabled = false;
    return rows.map(function (m) { return String(m.id); });
  }

  // HONEST FAIL. A visible, disabled option that NAMES what is missing, and a picker whose
  // value is "" so downstream gates block on it truthfully. Never a blank picker, never a
  // silent fallback to some hardcoded default: with nothing installed the user must be able
  // to see that nothing is installed.
  //
  // The caller passes the noun ("planning models", "image models"), so the message reads
  // "no planning models available" and points at the real missing thing.
  function renderEmpty(select, whatIsMissing) {
    select.innerHTML = "";
    addOption(select, "", "no " + whatIsMissing + " available", true);
  }

  function renderError(select, message) {
    select.innerHTML = "";
    addOption(select, "", "failed to load models: " + message, false);
  }

  // Apply a desired id against a known-good id list. An id the catalog no longer serves
  // drops VISIBLY: the picker lands on a real model and the caller is told what was lost,
  // instead of leaving the user with a blank picker and a preference they believe is live.
  // `onDropped(want, used)` is the caller hook so wording stays with the caller.
  function applyChoice(select, want, ids, onDropped) {
    delete select.dataset.pendingValue;
    if (ids.includes(want)) {
      select.value = want;
      return;
    }
    select.value = ids[0];
    if (onDropped) onDropped(want, select.value);
  }

  return {
    realOptionIds: realOptionIds,
    renderLoading: renderLoading,
    renderRows: renderRows,
    renderEmpty: renderEmpty,
    renderError: renderError,
    applyChoice: applyChoice,
  };
})();

if (typeof globalThis !== "undefined") globalThis.modelCatalog = modelCatalog;
