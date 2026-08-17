// Planner UI -- render stage + the LoRA training preflight gate.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- Render stage ----------

// cf#649: one sentence first, raw provider payload behind a fold.
function paintPlannerError(el, raw) {
  if (!el) return;
  const rec = window.plannerErrorRecipe
    ? window.plannerErrorRecipe.recipeFromError(raw)
    : { message: String(raw || "This render failed."), raw: String(raw || "") };
  el.innerHTML = "";
  const p = document.createElement("p");
  p.className = "planner-error-recipe";
  p.textContent = rec.message;
  el.appendChild(p);
  if (rec.raw && rec.raw !== rec.message) {
    const det = document.createElement("details");
    det.className = "planner-error-raw";
    const sum = document.createElement("summary");
    sum.textContent = "technical details";
    const pre = document.createElement("pre");
    pre.textContent = rec.raw;
    det.appendChild(sum);
    det.appendChild(pre);
    el.appendChild(det);
  }
}

// Filmmaker headline for the in-flight render. The raw job id stays in
// #planner-render-job-id (polling / resume read it) but is not the headline.
function setRenderJobHeadline(jobId) {
  const code = $("#planner-render-job-id");
  if (!code) return;
  code.textContent = jobId || "";
  if (code.closest("details")) return;
  const wrap = code.parentElement;
  if (!wrap) return;
  const details = document.createElement("details");
  details.className = "planner-render-job-details";
  const summary = document.createElement("summary");
  summary.textContent = "Technical details";
  const label = wrap.querySelector(".planner-render-label");
  if (label) label.textContent = "id";
  while (wrap.firstChild) details.appendChild(wrap.firstChild);
  details.insertBefore(summary, details.firstChild);
  wrap.appendChild(details);
}

function pinDownloadFilmLabel() {
  const a = $("#planner-render-download");
  if (a) a.textContent = "Download film";
}
pinDownloadFilmLabel();

function showRenderStage() {
  const stage = $("#planner-render");
  stage.hidden = false;
  $("#planner-render-result").hidden = true;
  stage.scrollIntoView({ behavior: "smooth", block: "start" });
  setRenderStatus("", "");
  // v0.221.0: a fresh visit to the render stage starts with no LoRA warning;
  // the next render click re-checks against fresh cast state.
  hideLoraPreflightWarning();
  loraPreflightAck = null;
  updateScatterGate();
  syncRenderModeUi();
}

// ---------- LoRA training preflight (v0.221.0) ----------
//
// A bound character whose LoRA is not trained-and-ready gets its LoRA RETRAINED
// inline (~15-25 min) on EVERY render via the server fail-safe (resolveCastLoras).
// That used to fire with no visible signal -- the bug this closes. Right before
// a render submit we re-read FRESH cast state and, if any bound slot will
// trigger the retrain tax, show a visible, actionable warning. It is NOT a hard
// block: the fail-safe is a valid escape hatch, so a second render click (with
// the same warning standing) proceeds anyway.
//
// FRESH, not cached: the page-load cast catalog's lora_status goes stale when
// training finishes after load (see buildCastLoraSubmit v0.135.6), so the gate
// re-fetches /api/cast before checking rather than trusting planState.castCatalog.

// Signature of the unready-slot set the user has already acknowledged by
// clicking render a second time. Reset whenever the set is empty or changes.
let loraPreflightAck = null;

function hideLoraPreflightWarning() {
  const el = $("#planner-lora-preflight-warning");
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
}

function paintLoraWarning(el, unready, proceedHint) {
  if (!el) return;
  const names = unready.map((u) => u.name).join(", ");
  el.textContent = "";
  const msg = document.createElement("span");
  msg.className = "planner-lora-preflight-msg";
  msg.textContent =
    "These characters are using portraits only: " + names + ". "
    + (proceedHint || "Faces may vary between shots.");
  const link = document.createElement("a");
  link.href = "cast";
  link.className = "planner-lora-preflight-link";
  link.textContent = "Open Cast";
  el.appendChild(msg);
  el.appendChild(document.createTextNode(" "));
  el.appendChild(link);
  el.hidden = false;
}

function showLoraPreflightWarning(unready) {
  paintLoraWarning(
    $("#planner-lora-preflight-warning"),
    unready,
    "Click render again to proceed anyway.",
  );
}

// Motion backend for the LoRA preflight gate: mirrors the render submit's backend
// pick so Wan-ready cast (wan_lora_key_high/low, no lora_key) is not misread.
function resolveMotionBackendForPreflight() {
  const kfOnly = $("#planner-keyframes-only");
  if (kfOnly && kfOnly.checked) return "";
  const motionSel = $("#planner-motion-backend");
  if (motionSel && motionSel.value) return motionSel.value;
  return "";
}

// Returns true when the render may proceed, false when it should pause on a
// freshly-shown warning. Re-fetches /api/cast so the readiness check is fresh.
async function loraPreflightGate() {
  const bindings = planState.castBindings || {};
  if (Object.keys(bindings).length === 0) {
    hideLoraPreflightWarning();
    loraPreflightAck = null;
    return true;
  }
  setRenderStatus("checking the cast...", "loading");
  // Refresh the catalog in place; loadCast swallows its own errors and leaves
  // the prior catalog on failure, which is an acceptable fall-back here.
  await loadCast();
  const motionBackend = resolveMotionBackendForPreflight();
  const unready = window.loraPreflight.unreadyBoundLoraSlots(bindings, planState.castCatalog, {
    motionBackend,
  });
  if (unready.length === 0) {
    hideLoraPreflightWarning();
    loraPreflightAck = null;
    setRenderStatus("", "");
    return true;
  }
  const sig = window.loraPreflight.loraSlotSignature(unready);
  if (loraPreflightAck === sig) {
    // Same warning the user already saw; they clicked render again -> proceed.
    hideLoraPreflightWarning();
    return true;
  }
  loraPreflightAck = sig;
  showLoraPreflightWarning(unready);
  setRenderStatus(
    unready.length === 1
      ? "1 character is using a portrait only (see note above)"
      : unready.length + " characters are using portraits only (see note above)",
    "error",
  );
  return false;
}

// Orchestrator-level parallelism (same class as qualityTier). Reads
// #planner-scatter-shards. Omitted or invalid -> min(shotN, 20). An
// explicit N is clamped to [1, shotN]. Writes max/value back so the
// control matches what will be sent. 2 is not a default. shotN < 1
// returns 1 and leaves the field empty so a later real shot count can
// still apply the implicit default.
function selectedMotionBackend() {
  const sel = $("#planner-motion-backend");
  return sel && typeof sel.value === "string" ? sel.value : "";
}

function plannerShardCount(shotN) {
  const shots = Math.max(0, Math.floor(Number(shotN)) || 0);
  const implicit = shots === 0 ? 1 : Math.min(shots, 20);
  const input = $("#planner-scatter-shards");
  if (!input) return implicit;
  input.min = "1";
  if (shots < 1) {
    input.max = "1";
    return 1;
  }
  const raw = input.value;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  let n = implicit;
  if (trimmed !== "") {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) n = Math.max(1, Math.min(Math.floor(parsed), shots));
  }
  input.max = String(shots);
  input.value = String(n);
  return n;
}

async function submitRender() {
  // vivijure#552: own the in-flight flag for the whole submit; cleared on jobId
  // handoff or on any bail/error path below.
  renderState.submitting = true;
  if (!bundleState.bundleKey) {
    setRenderStatus("no bundleKey; run 'bundle' first", "error");
    renderState.submitting = false;
    return;
  }
  if (!planState.storyboard || !Array.isArray(planState.storyboard.scenes) || planState.storyboard.scenes.length === 0) {
    setRenderStatus("no storyboard scenes; plan first", "error");
    renderState.submitting = false;
    return;
  }
  const filmScenes = buildFilmScenes(planState.storyboard);
  if (filmScenes.length === 0) {
    setRenderStatus("every scene needs a prompt before render", "error");
    renderState.submitting = false;
    return;
  }
  // v0.40.0: the keyframes-only checkbox is the source of truth for the next submission;
  // read it BEFORE collecting overrides so the collect can honor the #500 keyframes-only
  // exemption (vivijure#501) -- a keyframes-only preview runs no motion leg and needs no
  // backend pick, so it must never be blocked by the multi-backend choice gate.
  const kfOnlyEl = $("#planner-keyframes-only");
  const keyframesOnly = !!(kfOnlyEl && kfOnlyEl.checked);
  // v0.35.3 + module config: collect registry-driven overrides + optional expert JSON.
  let renderOverrides;
  try {
    renderOverrides = collectRenderOverrides({ keyframesOnly });
  } catch (err) {
    setRenderStatus(err.message, "error");
    const ta = $("#planner-render-overrides");
    if (ta) ta.focus();
    renderState.submitting = false;
    return;
  }
  // Stop any prior poll loop before starting a new render.
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  const qualityTier = $("#planner-quality-tier").value;
  const shardCount = plannerShardCount(filmScenes.length);
  // v0.40.0: the checkbox (read above) is the source of truth for the next submission. The
  // Worker merges this into render_overrides.keyframes_only=true on the wire; the GPU side
  // (vivijure-serverless 0.4.2+) short-circuits the orchestrator after the SDXL pass when
  // it is set.
  setRenderStatus(
    keyframesOnly ? "submitting keyframes-only preview..." : "submitting render pipeline...",
    "loading",
  );
  $("#planner-render-btn").disabled = true;

  const reqBody = {
    bundleKey: bundleState.bundleKey,
    scenes: filmScenes,
    shardCount,
  };
  // cf#62: omit rather than invent when the projection gave us no tiers (the scatter
  // path below already gates the same way); the core applies its own default.
  if (qualityTier) reqBody.qualityTier = qualityTier;
  // v0.43.0: buildRenderOverrides returns {} when nothing is set, so
  // gate on key count rather than truthiness; an empty object would
  // otherwise round-trip as `render_overrides: {}` and the Worker
  // would drop it anyway, but skipping it here keeps the wire clean.
  if (renderOverrides) reqBody.renderOverrides = renderOverrides;
  if (keyframesOnly) reqBody.keyframesOnly = true;
  // v0.52.0: forward the audio bed R2 key when one is set. The Worker
  // cross-bucket-copies MiniMax-generated keys (out/<uuid>.<ext>) into
  // env.R2_RENDERS at submit time; uploaded BYO audio (audio/<...>)
  // passes through. The GPU side (vivijure-serverless 0.4.11+) reads
  // audio_key from the job input, downloads, and muxes via
  // export_film(with_audio=True).
  if (planState.audioKey) reqBody.audioKey = planState.audioKey;
  // Forward the title / credit-card TEXT. The film.finish chain (film-titles) reads it off the job
  // (job.film_titles -> FilmFinishInput.title/credits); without this the cards never rendered from the
  // planner. Omitted when empty, and the core ignores it on a keyframes-only preview (no assembled film
  // to card), mirroring audioKey.
  const filmTitles = collectFilmTitles();
  if (filmTitles && !keyframesOnly) reqBody.film_titles = filmTitles;
  // v0.55.0: pin the render row to the active project so the history
  // list can filter by project. Skipped on transient (no-project)
  // submits, which matches the pre-0.55 behavior.
  if (planState.activeProjectId) reqBody.projectId = planState.activeProjectId;
  // v0.58.0: forward {slot: cast_id} bindings for any cast members
  // whose LoRA the GPU should reuse instead of training fresh. The
  // Worker resolves these to {slot: r2_key} via getCastById (ownership-
  // scoped, ready-status-gated) and the GPU (vivijure-serverless 0.4.14+)
  // stages the .safetensors into the project before Stage 1 so the
  // ready-slot pre-check short-circuits training for them.
  // v0.135.6: no cache refresh needed here; buildCastLoraSubmit now sends all
  // bound cast ids and the server gates readiness against fresh D1 state.
  const castLoraSubmit = buildCastLoraSubmit();
  if (Object.keys(castLoraSubmit).length > 0) reqBody.castLoras = castLoraSubmit;

  let resp = null;
  let data = null;
  try {
    resp = await fetch("/api/storyboard/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    data = await resp.json();
  } catch (err) {
    setRenderStatus("network error: " + err.message, "error");
    renderState.submitting = false;
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs = (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("submit failed: " + errs.join("; "), "error");
    renderState.submitting = false;
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!data || !data.jobId) {
    setRenderStatus("submit returned no jobId", "error");
    renderState.submitting = false;
    $("#planner-render-btn").disabled = false;
    return;
  }

  renderState.jobId = data.jobId;
  // vivijure#552: jobId set; the jobId/pollTimer guard now owns the button.
  renderState.submitting = false;
  // v0.44.0: reset the elapsed/ETA anchor on a fresh submit so a
  // previous render's startedAt does not leak in. updateRenderProgress
  // re-anchors on the first non-IN_QUEUE status update.
  renderState.startedAt = null;
  if (renderState.tickTimer !== null) {
    clearInterval(renderState.tickTimer);
    renderState.tickTimer = null;
  }
  // v0.37.0: track display name for notifications. Use the bundle's
  // derived project slug here; resumeRender will overwrite with the
  // history row's label when available.
  renderState.currentProject = deriveProjectFromKey(bundleState.bundleKey || "");
  renderState.currentLabel = null;
  // v0.37.0: ask for notification permission on the first submit when
  // we have not asked before. Done here (not on page load) so the
  // prompt arrives at the moment the value is most obvious: right
  // before a 10-to-30 minute wait.
  if (notifyState.permission === "default") {
    requestNotificationPermission();
  }
  $("#planner-render-result").hidden = false;
  setRenderJobHeadline(data.jobId);
  setJobStatusBadge(data.status || "IN_QUEUE");
  // v0.135.6: surface the server's LoRA reuse decision so a reused render is
  // visibly distinct from one that retrains. pretrainedSlots = slots the GPU
  // will skip training (cast LoRA staged); castLoraSkipped = slots trained
  // fresh, with a reason. Shown at submit (the moment it matters) + logged.
  const reusedSlots = Array.isArray(data.pretrainedSlots) ? data.pretrainedSlots : [];
  const skippedLoras = Array.isArray(data.castLoraSkipped) ? data.castLoraSkipped : [];
  let loraNote = "";
  if (reusedSlots.length) loraNote += " reusing trained LoRAs for " + reusedSlots.join(", ") + ".";
  if (skippedLoras.length) loraNote += " training fresh: " + skippedLoras.map((s) => s.slot + " (" + s.reason + ")").join(", ") + ".";
  if (loraNote) console.info("[render] LoRA:" + loraNote);
  setRenderStatus("submitted; opening stream..." + loraNote, "loading");
  startStream();
  // Refresh the history list so the new render appears at the top
  // without the user needing to click "refresh" manually.
  loadHistory();
  // v0.38.0: persist the new jobId so a tab close resumes the stream
  // on the next reload.
  savePersistedState();
}

// v0.162.0: enable/disable the scatter checkbox based on current state.
// Conditions: >= 2 shots in the storyboard AND castLoras non-empty (the
// server hard-400s a scatter with no castLoras; shards would diverge
// without a shared pre-trained LoRA). Shows a short reason when disabled.
function updateScatterGate() {
  const checkbox = $("#planner-scatter");
  const reasonEl = $("#planner-scatter-reason");
  const shardWrap = $("#planner-scatter-shard-wrap");
  if (!checkbox) return;

  const scenes =
    planState.storyboard && Array.isArray(planState.storyboard.scenes)
      ? planState.storyboard.scenes
      : [];
  const castLoras = buildCastLoraSubmit();
  const hasLoras = Object.keys(castLoras).length > 0;

  let reason = "";
  if (scenes.length < 2) reason = "needs >= 2 shots";
  else if (!hasLoras) reason = "every character needs a trained LoRA first";

  checkbox.disabled = !!reason;
  if (reason) checkbox.checked = false;

  if (reasonEl) {
    reasonEl.textContent = reason;
    reasonEl.hidden = !reason;
  }
  if (shardWrap) shardWrap.hidden = false;
  plannerShardCount(scenes.length);
}

// vivijure#546: gate the primary render button on a REQUIRED-but-unmade motion-backend
// choice so the obligation is a visible disabled affordance (mirroring the distributed-
// render checkbox), not a click-time-only block. Keyframes-only previews run no motion
// leg and are exempt. Presentation only; the collectForSubmit throw stays the hard
// backstop. Never fights the in-flight/streaming disable owned by the submit paths.
function updateRenderGate() {
  const btn = $("#planner-render-btn");
  if (!btn) return;
  const reasonEl = $("#planner-render-reason");
  // While a render is submitting/streaming the submit path owns the button; leave it be.
  if (renderState && (renderState.submitting || renderState.jobId || renderState.pollTimer)) return;
  const kfOnlyEl = $("#planner-keyframes-only");
  const keyframesOnly = !!(kfOnlyEl && kfOnlyEl.checked);
  const cfg = window.plannerRenderConfig;
  const pending = !keyframesOnly
    && cfg
    && typeof cfg.backendChoicePending === "function"
    && cfg.backendChoicePending();
  const reason = pending ? "pick a render backend above" : "";
  btn.disabled = !!reason;
  if (reasonEl) {
    reasonEl.textContent = reason;
    reasonEl.hidden = !reason;
  }
}

function isStillsMode() {
  const kf = $("#planner-keyframes-only");
  return !!(kf && kf.checked);
}

function setStillsMode(stills) {
  const kf = $("#planner-keyframes-only");
  if (kf) kf.checked = !!stills;
  syncRenderModeUi();
  persistSoon();
}

function syncRenderModeUi() {
  const stills = isStillsMode();
  const stillsRadio = $("#planner-mode-stills");
  const motionRadio = $("#planner-mode-motion");
  if (stillsRadio) stillsRadio.checked = stills;
  if (motionRadio) motionRadio.checked = !stills;
  const wrap = $("#planner-motion-backend-wrap");
  if (wrap) wrap.dataset.stills = stills ? "1" : "0";
  const btn = $("#planner-render-btn");
  if (btn && !(renderState && (renderState.submitting || renderState.jobId || renderState.pollTimer))) {
    btn.textContent = stills ? "Preview stills" : "Animate";
  }
  paintRenderSpend();
  updateRenderGate();
}

function selectedDoorCost() {
  const sel = $("#planner-motion-backend");
  if (!sel || !sel.value || !window.plannerRegistry || typeof window.plannerRegistry.motionBackendModules !== "function") {
    return "";
  }
  const mods = window.plannerRegistry.motionBackendModules() || [];
  const mod = mods.find((m) => m.name === sel.value);
  return mod && mod.ui && typeof mod.ui.cost === "string" ? mod.ui.cost : "";
}

function paintRenderSpend() {
  const el = $("#planner-render-spend");
  if (!el) return;
  const cfg = window.plannerRenderConfig;
  const stills = isStillsMode();
  const tierEl = $("#planner-quality-tier");
  const tier = tierEl && tierEl.value ? tierEl.value : "";
  const sentence = cfg && typeof cfg.spendSentence === "function"
    ? cfg.spendSentence({ stills, tier, cost: stills ? "" : selectedDoorCost() })
    : (stills
      ? "Stills preview; billed per render; usually a few minutes."
      : "Motion render; billed per render.");
  el.textContent = sentence;
}

// v0.162.0: POST to /api/storyboard/render/scatter and drive the existing
// renderState poll loop with the returned scatter-<uuid> jobId. Modeled on
// submitRender() -- reuses buildRenderOverrides, qualityTier, audioKey,
// projectId exactly. shotIds are derived via sceneIdAt (the canonical id
// source that matches the GPU's per-shot clip filenames).
async function submitScatterRender() {
  // vivijure#552: see submitRender.
  renderState.submitting = true;
  if (!bundleState.bundleKey) {
    setRenderStatus("no bundleKey; run 'bundle' first", "error");
    renderState.submitting = false;
    return;
  }
  const scenes =
    planState.storyboard && Array.isArray(planState.storyboard.scenes)
      ? planState.storyboard.scenes
      : [];
  const shotIds = scenes.map((s, i) => sceneIdAt(s, i));
  if (shotIds.length < 2) {
    setRenderStatus("scatter requires >= 2 shots", "error");
    renderState.submitting = false;
    return;
  }

  const castLoras = buildCastLoraSubmit();
  if (Object.keys(castLoras).length === 0) {
    setRenderStatus(
      "scatter requires at least one character with a trained LoRA bound",
      "error",
    );
    renderState.submitting = false;
    return;
  }

  // Talking characters: the scatter render reads per-shot dialogue from the SAVED storyboard in D1
  // (last_storyboard), so flush any unsaved edits (incl. dialogue lines) before submitting. No-ops
  // without an active project -- and dialogue needs a saved project for its projectId anyway.
  if (planState.activeProjectId) await saveStoryboardToProject();

  const shardCount = plannerShardCount(shotIds.length);

  let renderOverrides;
  try {
    renderOverrides = collectRenderOverrides();
  } catch (err) {
    setRenderStatus(err.message, "error");
    const ta = $("#planner-render-overrides");
    if (ta) ta.focus();
    renderState.submitting = false;
    return;
  }

  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }

  const qualityTier = $("#planner-quality-tier").value;
  setRenderStatus(
    "submitting a split render (" + shardCount + " parts)...",
    "loading",
  );
  $("#planner-render-btn").disabled = true;

  const reqBody = {
    bundleKey: bundleState.bundleKey,
    shotIds,
    shardCount,
    castLoras,
  };
  if (qualityTier) reqBody.qualityTier = qualityTier;
  if (renderOverrides) reqBody.renderOverrides = renderOverrides;
  if (planState.audioKey) reqBody.audioKey = planState.audioKey;
  if (planState.activeProjectId) reqBody.projectId = planState.activeProjectId;

  let resp = null;
  let data = null;
  try {
    resp = await fetch("/api/storyboard/render/scatter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    data = await resp.json();
  } catch (err) {
    setRenderStatus("network error: " + err.message, "error");
    renderState.submitting = false;
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs =
      (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("scatter submit failed: " + errs.join("; "), "error");
    renderState.submitting = false;
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!data || !data.jobId) {
    setRenderStatus("scatter submit returned no jobId", "error");
    renderState.submitting = false;
    $("#planner-render-btn").disabled = false;
    return;
  }

  renderState.jobId = data.jobId;
  // vivijure#552: jobId set; the jobId/pollTimer guard now owns the button.
  renderState.submitting = false;
  renderState.startedAt = null;
  if (renderState.tickTimer !== null) {
    clearInterval(renderState.tickTimer);
    renderState.tickTimer = null;
  }
  renderState.currentProject = deriveProjectFromKey(bundleState.bundleKey || "");
  renderState.currentLabel = null;
  if (notifyState.permission === "default") {
    requestNotificationPermission();
  }
  $("#planner-render-result").hidden = false;
  setRenderJobHeadline(data.jobId);
  setJobStatusBadge(data.status || "IN_QUEUE");
  setRenderStatus(
    "split render submitted -- " + shardCount + " parts gathering...",
    "loading",
  );
  startStream();
  loadHistory();
  savePersistedState();
}

// Render progress tracking. Polls GET /api/storyboard/render/<jobId> on an
// 8-second loop against the structured status channel (docs/observability.md);
// updateRenderProgress / finalizeRenderPoll consume each snapshot. A live SSE
// progress stream was scaffolded here client-side (v0.35.0) but the worker
// never had a matching /stream endpoint, so the EventSource attempt always
// errored straight to this poll while flashing a spurious "stream closed;
// falling back" status. That dead path was removed; the 8s poll is the single
// honest mechanism. Re-implementing SSE server-side is a post-announce
// enhancement (see issue #414).
function startStream() {
  pollRender();
}

// Stop render progress tracking. Named closeStream for caller compatibility
// with the removed SSE path; it now clears the poll loop (the callers that stop
// tracking pair it with the same clear, so this is idempotent).
function closeStream() {
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
}

// cf#515: THE ONLY PLACE THE RENDER POLL IS ARMED.
//
// Before this there were four bare `setTimeout(pollRender, POLL_INTERVAL_MS)`
// call sites and no jitter anywhere under public/ (Math.random appeared zero
// times), so every open panel re-armed on a flat 8s boundary. Unjittered
// self-rescheduling timers synchronise: clients that start inside one window
// converge and stay converged, arriving as a spike.
//
// That matters more than it looks, because this poll is not a read. It drives
// advanceFilmJob and therefore closes the film's DB row, so the poll cadence
// is what sets observation lag -- the metric cf#512 insists must never be
// folded into latency. Routing every arm through one function is what makes
// the policy testable at all (tests/poll-schedule-515.test.ts drives it with
// an injected random and an injected timer); four inline call sites were
// unreachable from any seam.
//
// Keep it that way: if you need to re-arm the poll, call this. A raw
// setTimeout(pollRender, ...) reintroduces the defect, and a test asserts
// there are none left.
function schedulePollRender() {
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  const hidden = typeof document !== "undefined" && document.hidden === true;
  renderState.pollTimer = pollSchedule.armPoll({
    hidden: hidden,
    errorStreak: renderState.pollErrorStreak,
    run: pollRender,
  });
  // armPoll returns null when it refused because the tab is hidden. Record
  // that as PAUSED rather than as "not polling", so the visibility handler
  // knows there is something to resume.
  renderState.pollPaused = renderState.pollTimer === null && !!renderState.jobId;
}

// cf#515: called from the single visibilitychange handler in planner-init.js.
// A backgrounded tab used to poll forever, so a run could never shed load;
// the pattern already existed one file over (planner-history-list.js guards on
// document.hidden) and had simply never been applied to the render poll.
function pauseRenderPoll() {
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  if (renderState.jobId) renderState.pollPaused = true;
}

// Resume with an IMMEDIATE poll rather than a fresh delay, so a tab that was
// hidden for ten minutes shows current state at once instead of after another
// interval. Mirrors loadHistory() on the history side. Guarded on pollPaused
// so returning to a tab whose render already finished does not restart a poll
// loop against a terminal job.
function resumeRenderPoll() {
  if (!renderState.jobId || !renderState.pollPaused) return;
  renderState.pollPaused = false;
  pollRender();
}

async function pollRender() {
  if (!renderState.jobId) return;
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }

  let resp = null;
  let data = null;
  try {
    resp = await fetch("/api/storyboard/render/" + encodeURIComponent(renderState.jobId));
    data = await resp.json();
  } catch (err) {
    setRenderStatus("poll network error: " + err.message + " (retrying)", "error");
    renderState.pollErrorStreak += 1;   // cf#515: back off rather than re-arm flat
    schedulePollRender();
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs = (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("poll failed: " + errs.join("; ") + " (retrying)", "error");
    renderState.pollErrorStreak += 1;   // cf#515: back off rather than re-arm flat
    schedulePollRender();
    return;
  }

  updateRenderProgress(data);

  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
  if (terminal.indexOf(data.status) >= 0) {
    finalizeRenderPoll(data);
    maybeNotifyTerminal(data);
    $("#planner-render-btn").disabled = false;
    return;
  }

  // Keep polling.
  // cf#515: "about every Ns" because the interval is now jittered per client.
  // Stating a flat number here would be a claim the scheduler no longer makes.
  renderState.pollErrorStreak = 0;
  setRenderStatus(
    data.status.toLowerCase() + "; polling about every "
      + Math.round(pollSchedule.POLL_BASE_MS / 1000) + "s",
    "loading",
  );
  schedulePollRender();
}

function updateRenderProgress(data) {
  setJobStatusBadge(data.status);

  const out = data.output;
  if (out && typeof out === "object") {
    if (typeof out.scene_total === "number" && out.scene_total > 0) {
      const el = $("#planner-render-scene");
      el.hidden = false;
      el.innerHTML = "";
      const done = typeof out.shots_done === "number"
        ? out.shots_done
        : (typeof out.scene_index === "number" ? Math.max(0, out.scene_index - 1) : 0);
      el.textContent = done + " of " + out.scene_total + " shots";
    }
    // cf#303: show a curated, user-facing phase NAME instead of the raw
    // pipeline token ("i2v", "mux"), which reads as jargon to a first-time
    // user. Unknown tokens pass through raw (renderEta.phaseLabel), so a new
    // backend phase degrades to unpolished rather than silently missing.
    // Falls back to statusRaw for the pre-submit "queued" window only, where
    // core's phaseProgress emits no `phase` key at all and the row was blank.
    const phaseSrc = (typeof out.phase === "string" && out.phase)
      ? out.phase
      : (data.statusRaw === "queued" ? "queued" : "");
    const phaseText = window.renderEta
      ? window.renderEta.phaseLabel(phaseSrc)
      : (phaseSrc || null);
    if (phaseText) {
      const el = $("#planner-render-phase");
      el.hidden = false;
      el.textContent = phaseText;
    }
    if (Array.isArray(out.log) && out.log.length > 0) {
      const wrap = $("#planner-render-log-wrap");
      wrap.hidden = false;
      $("#planner-render-log").textContent = out.log.join("\n");
    }
  }

  if (data.error) {
    const err = $("#planner-render-error");
    err.hidden = false;
    paintPlannerError(err, data.error);
  }

  // v0.44.0: progress bar + ETA. Anchor startedAt on the first non-
  // queued observation so a long IN_QUEUE wait does not skew the
  // elapsed math. Hide the widget entirely on terminal status; the
  // tick timer is also cleaned up there.
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
  if (terminal.indexOf(data.status) >= 0) {
    hideProgressWidget();
    return;
  }
  // v0.136.0: SUBMITTED (pre-confirmation) is a queue-equivalent wait; do not
  // anchor the elapsed/ETA clock on it any more than on IN_QUEUE.
  if (
    data.status !== "IN_QUEUE" &&
    data.status !== "SUBMITTED" &&
    renderState.startedAt === null
  ) {
    renderState.startedAt = Date.now();
    savePersistedState();
  }
  if (renderState.startedAt !== null) {
    refreshProgressWidget(out);
    if (renderState.tickTimer === null) {
      renderState.tickTimer = setInterval(() => {
        // No new data; just re-render the elapsed / ETA text against
        // the last-known progress fraction. cachedOut is the most
        // recent output we saw; null means we never observed one
        // (so the bar stays hidden until the first real update).
        refreshProgressWidget(renderState.lastOut);
      }, 1000);
    }
    // Cache the last observed output so the tick timer can re-render
    // the elapsed / ETA without a fresh status snapshot.
    renderState.lastOut = out && typeof out === "object" ? out : renderState.lastOut;
  }
}

// v0.44.0: pure-ish helper that converts the GPU's status envelope into
// a 0-1 progress fraction. Prefers out.progress (a float the GPU writes
// to render_status.json as render_fraction()); falls back to a count of
// completed scenes via (scene_index - 1) / scene_total when progress is
// absent. Returns null when neither signal is available, which the
// caller treats as "show the bar at 0% with 'computing...' ETA."
function computeProgressFraction(out) {
  // #115: the phase-aware overall-completion fraction lives in the testable
  // render-eta.js module (window.renderEta). The old inline scene-count logic
  // returned 0 for the whole keyframe phase and null for finish/assemble/mux,
  // so the UI sat at "?% eta computing..." for big stretches of a render. Keep
  // a tiny inline fallback so a missing script never throws (coarser guess).
  if (window.renderEta) return window.renderEta.progressFraction(out);
  if (!out || typeof out !== "object") return null;
  if (typeof out.progress === "number" && out.progress >= 0 && out.progress <= 1) {
    return out.progress;
  }
  if (
    typeof out.scene_index === "number"
    && typeof out.scene_total === "number"
    && out.scene_total > 0
  ) {
    return Math.min(1, Math.max(0, out.scene_index - 1) / out.scene_total);
  }
  return null;
}

// v0.44.0: paint the progress bar + ETA from the current renderState
// + an output snapshot. Called both on a real status update and on
// the 1s tick timer (with the cached last output) so the elapsed
// counter advances smoothly between snapshots.
function refreshProgressWidget(out) {
  const widget = $("#planner-render-progress");
  if (!widget) return;
  const startedAt = renderState.startedAt;
  if (startedAt === null) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const elapsedEl = $("#planner-render-progress-elapsed");
  if (elapsedEl) elapsedEl.textContent = formatDuration(elapsedMs);

  // cf#303: during the startup window the bar legitimately has no signal to
  // show, and a bare 0% is indistinguishable from a stall. Say so in words.
  // Words ONLY: the bar stays at its band floor, because inventing motion here
  // would be exactly the dishonesty render-eta.js refuses.
  //
  // The stall branch is the necessary other half: the reassuring startup note
  // must give way to the warning once the server says the phase has stopped
  // advancing, or it would explain away the very failure it was added to make
  // visible. The stall signal was already in the envelope and already shown in
  // the history list, but never in this live panel.
  const coldEl = $("#planner-render-coldstart");
  if (coldEl) {
    const eta = window.renderEta;
    let note = "";
    if (eta) {
      if (eta.isStalled(out)) note = eta.STALL_NOTE;
      else if (eta.isStartupWindow(out)) note = eta.COLD_START_NOTE;
    }
    coldEl.hidden = !note;
    coldEl.textContent = note;
    coldEl.classList.toggle("planner-render-coldstart-stalled", !!note && note === (eta && eta.STALL_NOTE));
  }

  const frac = computeProgressFraction(out);
  const pctEl = $("#planner-render-progress-pct");
  const fillEl = $("#planner-render-progress-fill");
  const etaEl = $("#planner-render-progress-eta");

  if (frac === null) {
    if (pctEl) pctEl.textContent = "?%";
    if (fillEl) fillEl.style.width = "0%";
    if (etaEl) etaEl.textContent = "computing...";
    return;
  }
  const pct = Math.round(frac * 100);
  if (pctEl) pctEl.textContent = pct + "%";
  if (fillEl) fillEl.style.width = pct + "%";

  // ETA: linear extrapolation, computed in the testable render-eta.js module
  // (window.renderEta.remainingMs). It withholds a number until we are
  // confident (>= 3% done and >= 10s elapsed) so early model-load skew never
  // produces a wild, scary estimate; null renders as "computing...".
  if (etaEl) {
    const remaining = window.renderEta
      ? window.renderEta.remainingMs(frac, elapsedMs)
      : null;
    etaEl.textContent = remaining === null ? "computing..." : "~" + formatDuration(remaining);
  }
}

// v0.44.0: tear down the progress widget on terminal status (and
// clear the tick timer). Idempotent so finalizeRender / cancel /
// re-submit can call it without checking state first.
function hideProgressWidget() {
  if (renderState.tickTimer !== null) {
    clearInterval(renderState.tickTimer);
    renderState.tickTimer = null;
  }
  renderState.lastOut = null;
  renderState.startedAt = null;
  const widget = $("#planner-render-progress");
  if (widget) widget.hidden = true;
  // cf#303: clear the cold-start note too, so a re-submit never opens showing
  // the previous render's queue message.
  const coldEl = $("#planner-render-coldstart");
  if (coldEl) {
    coldEl.hidden = true;
    coldEl.textContent = "";
  }
  savePersistedState();
}

function finalizeRenderPoll(data) {
  const elapsed = data.executionTimeMs
    ? " · ran for " + formatDuration(data.executionTimeMs)
    : "";

  if (data.status === "COMPLETED") {
    const out = data.output;
    // cf#118: the video-finish tier can be unavailable (VIDEO_FINISH_URL unbound on a
    // hosted tenant). The orchestrator then degrades honestly and SAYS SO in the payload;
    // the panel used to drop that on the floor and paint a plain green "completed".
    const degrade = window.finishDegrade ? window.finishDegrade.degradeFrom(out) : null;
    const clipFinish = window.finishDegrade ? window.finishDegrade.clipFinishFrom(out) : null;
    const limited = !!(degrade || clipFinish);
    setRenderStatus((limited ? "completed with limits" : "completed") + elapsed, limited ? "warn" : "success");
    const outpan = $("#planner-render-output");
    outpan.hidden = false;
    $("#planner-render-output-content").textContent = JSON.stringify(
      data.output || {},
      null,
      2,
    );
    renderDeliverable(out, degrade);
    return;
  }

  // Terminal failure of some flavor.
  setRenderStatus(data.status.toLowerCase() + elapsed, "error");
  const outpan = $("#planner-render-output");
  outpan.hidden = false;
  $("#planner-render-output-content").textContent = JSON.stringify(data.output || {}, null, 2);
  renderDeliverable(null, null);
}

// cf#118: paint the download affordances from what the render ACTUALLY delivered, and
// disclose any finishing degrade in prose.
//
// The stale-link half is a correctness fix, not cosmetics. The assemble degrade leaves
// `output_key` UNDEFINED (core film-output-key.js), and the old code only ever ASSIGNED
// the anchors, inside `if (typeof out.output_key === "string")`. Nothing reset them, so a
// degraded render following a good one in the same session left the download
// pointing at the PREVIOUS render, handing the user the wrong film labelled as this one.
// Every branch here now writes the anchors, including the empty case.
function renderDeliverable(out, degrade) {
  const fd = window.finishDegrade;
  const deliv = fd ? fd.deliverable(out) : { kind: (out && typeof out.output_key === "string") ? "film" : "none", key: (out && out.output_key) || null, clips: [] };
  const download = $("#planner-render-download");
  const open = $("#planner-render-open");

  if (deliv.kind === "film") {
    const url = "/api/artifact/" + deliv.key;
    download.href = url;
    download.download = ((out && out.project) || "film") + ".mp4";
    pinDownloadFilmLabel();
    download.hidden = false;
    open.href = url;
    open.hidden = false;
  } else {
    // No assembled film. CLEAR the links rather than leaving a stale target.
    download.removeAttribute("href");
    download.removeAttribute("download");
    download.hidden = true;
    open.removeAttribute("href");
    open.hidden = true;
  }

  renderDegradeNote(degrade, deliv, out);
}

// The disclosure block: our structural sentence, the studio reason VERBATIM, and the
// per-shot clips as real links when they are what was delivered. Rebuilt from scratch on
// every call so a stale note can never outlive the render that produced it.
function renderDegradeNote(degrade, deliv, out) {
  const host = $("#planner-render-degrade");
  if (!host) return;
  while (host.firstChild) host.removeChild(host.firstChild);
  const fd = window.finishDegrade;
  const clip = fd ? fd.clipFinishFrom(out) : null;
  if (!degrade && !clip) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const summary = fd && degrade ? fd.deliveredSummary(degrade) : null;
  if (summary) {
    const p = document.createElement("p");
    p.className = "render-degrade-summary";
    p.textContent = summary;
    host.appendChild(p);
  }

  // Rendered verbatim. The studio wrote the truest available description of why the step
  // is dead; paraphrasing it here would lose information the reader needs.
  if (degrade) {
    const why = document.createElement("p");
    why.className = "render-degrade-reason";
    why.textContent = degrade.reason;
    host.appendChild(why);
  }

  if (clip) {
    const clipSummary = fd.clipFinishSummary(clip);
    if (clipSummary) {
      const p = document.createElement("p");
      p.className = "render-degrade-summary";
      p.textContent = clipSummary;
      host.appendChild(p);
    }
    for (let i = 0; i < clip.reasons.length; i++) {
      const why = document.createElement("p");
      why.className = "render-degrade-reason";
      why.textContent = clip.reasons[i];
      host.appendChild(why);
    }
  }

  if (deliv.kind === "clips" && deliv.clips.length) {
    const h = document.createElement("h5");
    h.textContent = "delivered clips";
    host.appendChild(h);
    const ul = document.createElement("ul");
    ul.className = "render-degrade-clips";
    for (let i = 0; i < deliv.clips.length; i++) {
      const c = deliv.clips[i];
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "/api/artifact/" + c.key;
      a.textContent = c.shot_id;
      a.download = ((out && out.project) || "clip") + "-" + c.shot_id + ".mp4";
      li.appendChild(a);
      ul.appendChild(li);
    }
    host.appendChild(ul);
  }
}

function setJobStatusBadge(status) {
  const el = $("#planner-render-job-status");
  el.textContent = status;
  let kind = "running";
  if (status === "COMPLETED") kind = "done";
  if (status === "FAILED" || status === "CANCELLED" || status === "TIMED_OUT") kind = "error";
  el.className = "planner-render-job-status planner-render-status-" + kind;
  // Cancel button visible only while the job is still cancellable (queued
  // or running). RunPod accepts cancel on either; terminal states reject.
  const cancelBtn = $("#planner-render-cancel");
  // v0.136.0: SUBMITTED is the pre-confirmation state (we sent it, RunPod has
  // not echoed a /status yet). It is cancellable like IN_QUEUE.
  if (status === "SUBMITTED" || status === "IN_QUEUE" || status === "IN_PROGRESS") {
    cancelBtn.hidden = false;
    cancelBtn.disabled = false;
  } else {
    cancelBtn.hidden = true;
  }
  // v0.63.0: dismiss button mirrors cancel - shown only when the job is
  // in a terminal state, so the user can hide a stale FAILED / CANCELLED
  // banner that would otherwise stick around until the next render.
  const dismissBtn = $("#planner-render-dismiss");
  if (dismissBtn) {
    const terminal =
      status === "COMPLETED"
      || status === "FAILED"
      || status === "CANCELLED"
      || status === "TIMED_OUT";
    dismissBtn.hidden = !terminal;
  }
}

// v0.63.0: hide the render-result panel and clear the persisted snapshot
// so the same stale row does not reappear on the next page load. Only
// callable from the dismiss button, which the UI gates on a terminal
// status; in-flight jobs are not dismissable (use "cancel job" first).
function dismissRenderResult() {
  closeStream();
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  if (renderState.tickTimer !== null) {
    clearInterval(renderState.tickTimer);
    renderState.tickTimer = null;
  }
  renderState.jobId = null;
  renderState.currentProject = null;
  renderState.currentLabel = null;
  renderState.startedAt = null;
  $("#planner-render-result").hidden = true;
  $("#planner-render-log-wrap").hidden = true;
  $("#planner-render-output").hidden = true;
  $("#planner-render-error").hidden = true;
  $("#planner-render-progress").hidden = true;
  setRenderStatus("", "");
  savePersistedState();
}

async function cancelRender() {
  if (!renderState.jobId) return;
  // Optimistic UX: disable the button and pause the live updates while
  // the cancel call is in flight. Failure restores the button (still
  // cancellable); success lets the next stream / poll event pick up the
  // CANCELLED state.
  const cancelBtn = $("#planner-render-cancel");
  cancelBtn.disabled = true;
  setRenderStatus("requesting cancel...", "loading");
  closeStream();
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }

  let resp = null;
  let data = null;
  try {
    resp = await fetch(
      "/api/storyboard/render/" + encodeURIComponent(renderState.jobId),
      { method: "DELETE" },
    );
    data = await resp.json();
  } catch (err) {
    setRenderStatus("cancel network error: " + err.message, "error");
    cancelBtn.disabled = false;
    // Resume polling so the UI keeps reflecting reality. cf#515: the CANCEL
    // call failed, not the poll, so the poll error streak is deliberately left
    // alone -- backing the poll off for a cancel fault would slow the very
    // updates the user is waiting on.
    schedulePollRender();
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs = (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("cancel failed: " + errs.join("; "), "error");
    cancelBtn.disabled = false;
    // Resume the live stream so the user keeps seeing real-time updates.
    startStream();
    return;
  }

  // RunPod accepted the cancel; the next stream event will see CANCELLED.
  setRenderStatus("cancel requested; awaiting final status", "loading");
  if (data && data.status) setJobStatusBadge(data.status);
  startStream();
}

function resetRenderStage() {
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  closeStream();
  renderState.jobId = null;
  $("#planner-render").hidden = true;
  $("#planner-render-result").hidden = true;
  // v0.35.3: clear the renderOverrides textarea on re-plan so a stale
  // value from a prior re-render does not silently carry forward into
  // the next submit.
  const overridesTextarea = $("#planner-render-overrides");
  if (overridesTextarea) overridesTextarea.value = "";
  const overridesDetails = $(".planner-overrides-details");
  if (overridesDetails) overridesDetails.open = false;
  setRenderStatus("", "");
}

