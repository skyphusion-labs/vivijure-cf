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
  sel.dataset.pendingValue = String(value);
  sel.value = String(value);
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
    const ids = data.models.map((m) => String(m.id));
    const want = ids.includes(pending) ? pending : ids.includes(prev) ? prev : "";
    if (want) select.value = want;
    // A saved model that the catalog no longer serves drops VISIBLY, never silently:
    // the picker falls back to the first available model and says why, so the user is
    // not left believing a stale preference is still in effect.
    if (pending && !ids.includes(pending)) {
      setStatus(
        "saved planning model \"" + pending + "\" is no longer available; using \""
          + select.value + "\" instead",
        "error",
      );
    }
    delete select.dataset.pendingValue;
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

