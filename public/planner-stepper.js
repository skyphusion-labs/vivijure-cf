// Planner UI -- constants, the guided stepper, and render-override / film-title collectors.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// Storyboard planner UI (v0.33.0).
//
// Hydrates the model picker from GET /api/storyboard/models, takes a brief
// plus up to four character entries (slots A through D), and walks the
// three-stage pipeline:
//
//   1. plan    POST /api/storyboard/plan
//                  -> validated storyboard JSON + bundle-ready YAML, or
//                  -> validator errors + raw model output (re-prompt path).
//   2. bundle  POST /api/storyboard/character-ref (per training image),
//              then POST /api/storyboard/bundle (assemble the .tar.gz).
//   3. render  POST /api/storyboard/render (module film pipeline), then
//              GET /api/storyboard/render/<jobId> on an 8-second poll
//              loop until the job hits a terminal status.
//
// Vanilla JS, no framework. Reuses the chat UI's CSS tokens from styles.css.

const SLOT_IDS = ["A", "B", "C", "D"];
// cf#515: the render-poll cadence moved to poll-schedule.js
// (pollSchedule.POLL_BASE_MS) along with the jitter, backoff and visibility
// policy that now govern it. A second copy of the number here would be a
// hand-maintained duplicate of a value that already has an owner, and those
// drift; the poll is scheduled through pollSchedule.armPoll, never from a bare
// constant.
const HISTORY_LIMIT = 25;
const HISTORY_AUTO_REFRESH_MS = 30000;
// v0.38.0: localStorage key for the persisted planner state. Bumped when
// the shape changes incompatibly so a stale stash never crashes restore.
const STORAGE_KEY = "skyphusion.planner.state.v1";
// v0.38.0: debounce form-input saves so a typed brief does not write to
// localStorage on every keystroke.
const PERSIST_DEBOUNCE_MS = 500;

const $ = (sel) => document.querySelector(sel);

// ---------- Guided stepper (v0.120.0) ----------
//
// The planner is one long pipeline. The stepper shows a single step at a
// time: every top-level <section> carries a data-step, and showStep()
// collapses every section whose data-step is not the active step (the
// .step-hidden class sits on top of each section's own progressive-reveal
// `hidden`, so the in-step reveal logic is untouched). Steps unlock as
// prerequisites are met so the user cannot jump to Render before a bundle
// exists. The state lives in module scope alongside the pipeline state below.

const PLANNER_STEPS = [
  { id: "cast", label: "Cast" },
  { id: "plan", label: "Plan" },
  { id: "render", label: "Render" },
  { id: "history", label: "Your films" },
];
const PLANNER_STEP_ORDER = PLANNER_STEPS.map((s) => s.id);

const stepState = {
  current: "cast",
  unlocked: { cast: true, plan: true, render: false, history: true },
};

// Cast + Plan + Your films are always open. You pick people first so the
// planner can put them in shots. Render still needs a staged bundle (or a
// film already in flight / loaded from history).
function computeStepUnlocked() {
  const hasBundle =
    !!(bundleState && bundleState.bundleKey) || !!(renderState && renderState.jobId);
  return { cast: true, plan: true, render: hasBundle, history: true };
}

function buildStepper() {
  const rail = $("#planner-steps");
  if (!rail) return;
  rail.innerHTML = "";
  PLANNER_STEPS.forEach((step, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "planner-step";
    btn.dataset.stepId = step.id;
    const num = document.createElement("span");
    num.className = "planner-step-num";
    num.textContent = String(i + 1);
    const lbl = document.createElement("span");
    lbl.className = "planner-step-label-long";
    lbl.textContent = step.label;
    btn.appendChild(num);
    btn.appendChild(lbl);
    btn.addEventListener("click", () => showStep(step.id));
    rail.appendChild(btn);
  });
  const back = $("#planner-step-back");
  if (back) back.addEventListener("click", () => stepDelta(-1));
  const next = $("#planner-step-next");
  if (next) next.addEventListener("click", () => stepDelta(1));
}

// Reflect unlock state on the rail without changing the active step. If the
// active step just became locked (e.g. a reset cleared the plan), fall back
// to the furthest still-unlocked step at or before it.
function refreshSteps() {
  stepState.unlocked = computeStepUnlocked();
  if (!stepState.unlocked[stepState.current]) {
    const idx = PLANNER_STEP_ORDER.indexOf(stepState.current);
    let fallback = "plan";
    for (let i = idx; i >= 0; i--) {
      if (stepState.unlocked[PLANNER_STEP_ORDER[i]]) {
        fallback = PLANNER_STEP_ORDER[i];
        break;
      }
    }
    showStep(fallback);
    return;
  }
  paintStepper();
}

// Switch the active step: collapse non-active sections, repaint the rail +
// the back/next buttons, scroll to the top of the column.
function showStep(id) {
  // cf#645: Audio is no longer a rail step. Old stash / callers that still
  // ask for it land on Render, where the audio fold lives.
  if (id === "audio") id = "render";
  if (!stepState.unlocked[id]) return;
  stepState.current = id;
  document.querySelectorAll("[data-step]").forEach((el) => {
    // v0.164.0: refine lives in the fixed dock, not the step column; never
    // collapse it when switching planner steps.
    if (el.closest("#sw-dock")) return;
    el.classList.toggle("step-hidden", el.dataset.step !== id);
  });
  // v0.165.0 (#144): showPreflightSection() and the bundle section are only
  // revealed at plan-completion time; navigating back to Cast & Bundle must
  // re-evaluate them so the sections appear.
  if (id === "cast") {
    showCastSection();
  }
  if (id === "render") {
    showAudioSection();
  }
  paintStepper();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function paintStepper() {
  const curIdx = PLANNER_STEP_ORDER.indexOf(stepState.current);
  document.querySelectorAll("#planner-steps .planner-step").forEach((btn) => {
    const sid = btn.dataset.stepId;
    const sIdx = PLANNER_STEP_ORDER.indexOf(sid);
    btn.classList.toggle("is-active", sid === stepState.current);
    // a step before the current one that is unlocked reads as "done"
    btn.classList.toggle("is-done", sIdx < curIdx && !!stepState.unlocked[sid]);
    btn.disabled = !stepState.unlocked[sid];
  });
  const back = $("#planner-step-back");
  if (back) back.disabled = curIdx <= 0;
  const next = $("#planner-step-next");
  if (next) {
    const nextId = PLANNER_STEP_ORDER[curIdx + 1];
    next.disabled = !nextId || !stepState.unlocked[nextId];
    if (stepState.current === "plan" && nextId === "render" && !stepState.unlocked.render) {
      next.title = "Pick people on Cast (their staged faces pack automatically)";
    } else {
      next.title = "";
    }
  }
}

// Move relative to the current step. Forward moves one step at a time (never
// skips a locked Render into History). Backward skips locked steps.
function stepDelta(dir) {
  const curIdx = PLANNER_STEP_ORDER.indexOf(stepState.current);
  if (dir > 0) {
    const nextId = PLANNER_STEP_ORDER[curIdx + 1];
    if (nextId && stepState.unlocked[nextId]) showStep(nextId);
    return;
  }
  let i = curIdx + dir;
  while (i >= 0 && i < PLANNER_STEP_ORDER.length && !stepState.unlocked[PLANNER_STEP_ORDER[i]]) {
    i += dir;
  }
  if (i >= 0 && i < PLANNER_STEP_ORDER.length) showStep(PLANNER_STEP_ORDER[i]);
}

