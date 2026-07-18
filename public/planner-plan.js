// Planner UI -- model picker hydration + the plan-stage dispatcher.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- Model picker hydration ----------

// cf#62: select a planning model robustly regardless of whether the projected
// <option>s exist yet. Mirrors plannerRenderConfig.selectTier: set .value (effective
// if the options are built) AND stash the desired value so loadModels honors it once
// they are. Every restore path (session stash, project prefs) goes through here
// instead of assigning .value directly.
//
// Why this exists: the catalog is PROJECTED from the installed plan.enhance modules,
// so it arrives asynchronously and its contents can change between sessions. A bare
// `select.value = savedId` loses in two ways -- it is dropped entirely when it runs
// before the options are built (a race against loadModels), and it silently blanks
// the picker when the saved id is no longer in the catalog (a module uninstalled, an
// enum edited, a third-party module swapped).
function selectPlanningModel(value) {
  const sel = $("#planner-model");
  if (!sel || !value) return;
  const want = String(value);
  const ids = realOptionIds(sel);
  // The catalog is ALREADY loaded (the common case: switching projects mid-session).
  // Resolve NOW rather than stashing: a stash would leave the picker blank and silent
  // until the next loadModels(), which in normal use may never come.
  if (ids.length) {
    applyModelChoice(sel, want, ids);
    return;
  }
  // The catalog has not arrived yet (session restore during init). Stash it; loadModels
  // resolves it against the real ids the moment they exist.
  sel.dataset.pendingValue = want;
  sel.value = want;
}

// The selectable model ids currently in the picker: real projected models only, never the
// "loading..." / "no planning models available" placeholders (those carry an empty value).
function realOptionIds(sel) {
  return Array.from(sel.options).map((o) => String(o.value)).filter(Boolean);
}

// Apply a desired model id against a known-good id list. A id the catalog no longer serves
// drops VISIBLY -- the picker lands on a real model and says what was lost -- instead of
// leaving the user with a blank picker and a preference they believe is still in effect.
function applyModelChoice(sel, want, ids) {
  delete sel.dataset.pendingValue;
  if (ids.includes(want)) {
    sel.value = want;
    return;
  }
  sel.value = ids[0];
  setStatus(
    "saved planning model \"" + want + "\" is no longer available; using \"" + sel.value + "\" instead",
    "error",
  );
}

async function loadModels() {
  const select = $("#planner-model");
  // Desired value, in priority order: a restore that ran before the options existed
  // (data-pending-value), then the current selection (preserved across re-loads).
  // BOTH are captured BEFORE the loading placeholder replaces the options -- reading
  // `prev` after that wipe would only ever see the placeholder, silently losing the
  // user's current pick on every refresh.
  const pending = select.dataset.pendingValue || "";
  const prev = select.value;
  select.disabled = true;
  select.innerHTML = '<option>loading models...</option>';
  try {
    const resp = await fetch("/api/storyboard/models");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    select.innerHTML = "";
    if (!Array.isArray(data.models) || data.models.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.disabled = true;
      opt.textContent = "no planning models available";
      select.appendChild(opt);
      // Keep the restore pending: installing a plan.enhance module and reloading
      // should still land on the user's saved choice.
      return;
    }
    for (const model of data.models) {
      const opt = document.createElement("option");
      opt.value = model.id;
      opt.textContent = model.label || model.id;
      select.appendChild(opt);
    }
    select.disabled = false;
    // ONE resolver shared with selectPlanningModel, so an early restore and a mid-session
    // restore cannot drift apart in what they do with a stale id.
    const ids = data.models.map((m) => String(m.id));
    if (pending) applyModelChoice(select, pending, ids);
    else if (ids.includes(prev)) select.value = prev;
  } catch (err) {
    select.innerHTML = "";
    const opt = document.createElement("option");
    opt.textContent = "failed to load models: " + err.message;
    select.appendChild(opt);
  }
}

// ---------- Plan stage dispatcher ----------

async function plan() {
  const briefEl = $("#planner-brief");
  const model = $("#planner-model").value;
  const brief = briefEl.value.trim();

  if (!brief) {
    setStatus("brief is required", "error");
    briefEl.focus();
    return;
  }
  if (!model) {
    setStatus("select a model first", "error");
    return;
  }

  const characters = collectCast();

  // v0.161.1: evict the prior storyboard from both memory and the persisted
  // snapshot BEFORE the fetch so the YAML view never shows a previous project
  // during the in-flight window (brief->YAML stale-state bug, issue #4).
  planState.storyboard = null;
  planState.originalStoryboard = null;
  planState.refineHistory = [];
  $("#planner-output").hidden = true;
  $("#planner-output-state").textContent = "";
  // Reset any prior bundle / render state when re-planning.
  resetBundleStage();
  resetRenderStage();
  savePersistedState();

  setStatus("planning, this can take 5 to 30 seconds...", "loading");
  $("#planner-plan").disabled = true;

  let httpStatus = 0;
  let data = null;
  try {
    const resp = await fetch("/api/storyboard/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief, characters, model }),
    });
    httpStatus = resp.status;
    try {
      data = await resp.json();
    } catch {
      data = { error: "non-JSON response from server" };
    }
  } catch (err) {
    setStatus("network error: " + err.message, "error");
    $("#planner-plan").disabled = false;
    return;
  } finally {
    $("#planner-plan").disabled = false;
  }

  renderPlanResult(httpStatus, data, model, characters);
}

function renderPlanResult(httpStatus, data, model, characters) {
  $("#planner-output").hidden = false;
  $("#planner-output-meta").textContent =
    "model: " + model + " · HTTP " + httpStatus;
  const state = $("#planner-output-state");
  const errorsPanel = $("#planner-errors");
  const resultPanel = $("#planner-result");
  const rawPanel = $("#planner-raw");

  if (httpStatus === 400) {
    state.textContent = "request rejected";
    state.className = "planner-output-state planner-error";
    errorsPanel.hidden = false;
    resultPanel.hidden = true;
    rawPanel.hidden = true;
    renderErrors([data && data.error ? data.error : "unknown 400 error"]);
    setStatus("400: " + (data && data.error ? data.error : "request rejected"), "error");
    return;
  }

  if (httpStatus === 502 || (data && data.ok === false)) {
    const isUpstream = httpStatus === 502;
    state.textContent = isUpstream ? "upstream error" : "model output invalid";
    state.className = "planner-output-state planner-error";
    errorsPanel.hidden = false;
    renderErrors((data && data.errors) || ["unknown error"]);
    resultPanel.hidden = true;
    if (data && data.raw) {
      rawPanel.hidden = false;
      $("#planner-raw-content").textContent = data.raw;
    } else {
      rawPanel.hidden = true;
    }
    setStatus(
      isUpstream ? "upstream call failed (502)" : "model output did not validate",
      "error",
    );
    return;
  }

  if (data && data.ok === true) {
    state.textContent = "ok";
    state.className = "planner-output-state planner-success";
    errorsPanel.hidden = true;
    rawPanel.hidden = true;
    resultPanel.hidden = false;
    $("#planner-json").textContent = JSON.stringify(data.storyboard, null, 2);
    $("#planner-yaml").textContent = ""; // #743: clear stale preview; refreshYamlPreview() below fills it once planState.storyboard is set
    const sceneCount =
      data.storyboard && data.storyboard.scenes ? data.storyboard.scenes.length : 0;
    setStatus("planned successfully (" + sceneCount + " scenes)", "success");
    // Set storyboard before any showXxxSection() calls so they see a
    // non-null storyboard and unhide correctly. showBundleStage() will
    // also set it (same value); this just ensures the order is safe. (v0.162.2)
    planState.storyboard = data.storyboard;
    // #743: the plan response carries no yaml field; fetch the preview the same
    // way scene-edit and project-load do, so the YAML tab is not blank until edit.
    refreshYamlPreview();
    // v0.49.0: snapshot the freshly-planned storyboard so a "discard
    // edits" button can roll back any subsequent scene-editor mutations.
    planState.originalStoryboard = JSON.parse(JSON.stringify(data.storyboard));
    // v0.50.0: fresh plan resets the refinement chat history (a new
    // storyboard is a new conversation).
    planState.refineHistory = [];
    showRefineSection();
    // v0.51.0: a fresh plan keeps the audio bed + BPM (those are about
    // the music + tempo, not the storyboard structure) but resets the
    // pending music-gen chat id and re-renders the section so the
    // controls reflect the new storyboard's scene set.
    planState.pendingMusicChatId = null;
    planState.pendingMusicModule = null;
    planState.pendingScoreBedKind = null;
    planState.pendingScoreBedLabel = null;
    // v0.137.6: a fresh storyboard is a new soundtrack target, so let the
    // music-prompt auto-suggestion fire again the next time Audio is opened.
    musicPromptAutoTried = false;
    showAudioSection();
    renderSceneEditor(data.storyboard);
    // v0.54.0: show the preflight section and auto-run a first check
    // so the user sees the panel's state immediately.
    showPreflightSection();
    runPreflight();
    showBundleStage(data.storyboard, characters);
    // v0.120.0: a fresh plan unlocks Cast & Bundle + Audio. Stay on the Plan
    // step so the user can review the output / refine; the rail lights up.
    refreshSteps();
    savePersistedState();
    return;
  }

  state.textContent = "unexpected response shape";
  state.className = "planner-output-state planner-error";
  errorsPanel.hidden = false;
  resultPanel.hidden = true;
  rawPanel.hidden = true;
  renderErrors(["unexpected response shape; see network tab"]);
  setStatus("unexpected response shape", "error");
}

function renderErrors(errors) {
  const list = $("#planner-errors-list");
  list.innerHTML = "";
  for (const err of errors) {
    const li = document.createElement("li");
    li.textContent = err;
    list.appendChild(li);
  }
}

function repromptWithErrors() {
  const items = document.querySelectorAll("#planner-errors-list li");
  if (items.length === 0) return;
  const errors = Array.from(items).map((li) => li.textContent);
  const briefEl = $("#planner-brief");
  const current = briefEl.value.trim();
  const block = [
    "",
    "",
    "PREVIOUS ATTEMPT FAILED VALIDATION. Please retry, fixing these issues:",
    ...errors.map((e) => "- " + e),
  ].join("\n");
  briefEl.value = current + block;
  briefEl.focus();
  briefEl.scrollIntoView({ behavior: "smooth", block: "start" });
  setStatus("brief updated with errors; click 'plan' to retry", "loading");
}

