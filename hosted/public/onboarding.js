// Hosted-tier onboarding flow (#58). Vanilla JS, no framework, no build step.
//
// WHAT IS SETTLED HERE vs WHAT IS NOT
// -----------------------------------
// Settled (this file owns it): the flow, the copy, the gates, and the rule that
// every number shown to the user is one we actually read back from RunPod.
//
// NOT settled (do not treat as contract): the API shapes in PlatformApi below.
// The control plane is Rollins' lane (#52 skeleton, #54 provisioner). These are
// a PROVISIONAL seam so the screens are drivable today; they are mocked until a
// real base is wired. When #52 posts the real contract, this adapter is the only
// place that changes -- the screens read from the returned data, never from
// hardcoded knowledge of what a plan contains.
//
// SECRET HYGIENE (hard rule): the pasted RunPod key lives in ONE closure
// variable. It is never written to localStorage/sessionStorage, never put in a
// URL, never logged, and never sent anywhere but the control plane over POST.
// It is cleared the moment provisioning finishes. The input is type=password and
// the reveal toggle is opt-in.
(function () {
  "use strict";

  const checks = window.onboardingChecks;

  // The control plane's origin. Empty means same-origin, which is the normal
  // case: this page is served BY the control plane.
  const API_BASE = window.HOSTED_API_BASE || "";

  // Mock mode is an EXPLICIT opt-in (?mock=1, or data-mock on <html>), never a
  // fallback.
  //
  // This was the other way round for one commit, and it was a real trap: mock
  // was inferred from "no API base configured," which is exactly what a normal
  // same-origin production deploy looks like. A misconfigured control plane
  // would then have served a real stranger a real-looking signup page full of
  // invented numbers (quota 10, $0.44) and a fake "your studio is live" link.
  // A page that cannot reach its API must look BROKEN, loudly, never
  // fake-working: honest failures apply to the front door too. Now a broken
  // deploy throws a visible fetch error, and fabricated data can only ever
  // appear when someone deliberately asked for the preview.
  const params = new URLSearchParams(window.location.search);
  const USE_MOCK =
    params.get("mock") === "1" || document.documentElement.dataset.mock === "1";

  // ---- the keys, and nowhere else ---------------------------------------
  // Two-phase custody (#52 ruling). Key A is transient and dies at the end of
  // provisioning. Key B is verified before it is kept, and this page never
  // keeps either one: both live in a closure and go nowhere else.
  let runpodKey = "";   // key A: transient, graphql R/W, used once to build
  let invokeKey = "";   // key B: invoke-only on the 4 created endpoints
  function clearKey() { runpodKey = ""; }
  function clearInvokeKey() { invokeKey = ""; }

  const state = {
    rulesAccepted: false,
    keyPresent: false,
    capacity: null,
    confirmed: false,
    invokeVerified: false,
    plan: [],
    costExample: null,
    studioUrl: null,
    createdEndpoints: [],
    provisionJobId: null,
  };

  let current = "what";

  // ---- API seam (PROVISIONAL, pending #52/#54) --------------------------
  const PlatformApi = {
    // GET the provisioning plan: which endpoints get created, and the pinned
    // max_workers for each. DATA, not a UI constant -- the review screen
    // renders whatever rows come back.
    async plan() {
      if (USE_MOCK) return mock.plan();
      const r = await fetch(API_BASE + "/api/hosted/plan");
      if (!r.ok) throw new Error("could not load the setup plan (" + r.status + ")");
      return r.json();
    },

    // POST the key once, transiently, to read the account's REAL quota and the
    // worker sum its existing endpoints already spend. The control plane does
    // not store the key on this call.
    async capacity(key) {
      if (USE_MOCK) return mock.capacity();
      const r = await fetch(API_BASE + "/api/hosted/capacity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runpod_key: key }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(function () { return ""; });
        throw new Error("RunPod capacity check failed (" + r.status + "). " + detail);
      }
      return r.json();
    },

    async provision(key) {
      if (USE_MOCK) return mock.provision();
      const r = await fetch(API_BASE + "/api/hosted/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runpod_key: key }),
      });
      if (!r.ok) throw new Error("could not start setup (" + r.status + ")");
      return r.json();
    },

    async provisionStatus(jobId) {
      if (USE_MOCK) return mock.provisionStatus();
      const r = await fetch(API_BASE + "/api/hosted/provision/" + encodeURIComponent(jobId));
      if (!r.ok) throw new Error("could not read setup status (" + r.status + ")");
      return r.json();
    },

    // Key B: the control plane probes its scope LIVE before storing it
    // (health on each created endpoint + graphql must be denied), then installs
    // it via the per-script secrets PUT. A wrongly-scoped key is rejected and
    // never stored -- that refusal is the whole point of the two-phase design.
    async invokeKey(jobId, key) {
      if (USE_MOCK) return mock.invokeKey();
      const r = await fetch(API_BASE + "/api/hosted/provision/" + encodeURIComponent(jobId) + "/invoke-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoke_key: key }),
      });
      const body = await r.json().catch(function () { return {}; });
      if (!r.ok && !body.probe) {
        throw new Error(body.error || "could not check that key (" + r.status + ")");
      }
      return body;
    },

    // Ernst's versioned AUP text (#57). Until it exists the marked placeholder
    // seam in the HTML stays visible.
    async aup() {
      if (USE_MOCK) return null;
      const r = await fetch(API_BASE + "/api/hosted/aup");
      if (!r.ok) return null;
      return r.json();
    },

    async acceptAup(version) {
      if (USE_MOCK) return { ok: true };
      const r = await fetch(API_BASE + "/api/hosted/aup/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: version }),
      });
      if (!r.ok) throw new Error("could not record your acceptance (" + r.status + ")");
      return r.json();
    },
  };

  // ---- mock data (preview only; the banner is loud about it) ------------
  //
  // The plan mirrors the spec's shapes as of 2026-07-17 (spike deltas: pin
  // max_workers explicitly; 2+1+1+1 fits any observed quota). The provisioner
  // (#54) is the authority; when it lands, these numbers come from it.
  const mock = {
    plan() {
      return {
        endpoints: [
          { key: "backend", label: "backend", purpose: "The main render: keyframes, video, and cast LoRA training", image: "ghcr.io/skyphusion-labs/vivijure-backend", max_workers: 2, gpu: "H200 / B200" },
          { key: "upscale", label: "upscale", purpose: "Makes finished video sharper", image: "ghcr.io/skyphusion-labs/vivijure-upscale", max_workers: 1, gpu: "RTX 6000 Pro" },
          { key: "lipsync", label: "lipsync", purpose: "Matches mouth movement to dialogue", image: "ghcr.io/skyphusion-labs/vivijure-musetalk", max_workers: 1, gpu: "RTX 6000 Pro" },
          { key: "audio-upscale", label: "audio-upscale", purpose: "Cleans up and sharpens audio", image: "ghcr.io/skyphusion-labs/vivijure-audio-upscale", max_workers: 1, gpu: "RTX 6000 Pro" },
        ],
        // A real, named render from our own history (film-2294a9d7, 2026-07-14:
        // 2 shots, 10s of finished video, final quality). wall_clock_ms is
        // wall-clock since submit, so the derived cost is a CEILING and is
        // labelled as one wherever it is shown. Provenance travels WITH the
        // number so a reader can audit it.
        cost_example: {
          job_id: "film-2294a9d7-d994-4807-8ed8-301a8e2fd796",
          rendered_on: "2026-07-14",
          description: "a 2-shot film, 10 seconds of finished video, final quality",
          wall_clock_ms: 362857,
          gpu_hourly_usd: 4.39,
          gpu_label: "H200 secure",
          rate_checked_on: "2026-07-17",
        },
      };
    },
    capacity() {
      return { quota: 10, existing_worker_sum: 0 };
    },
    provision() { return { job_id: "mock-provision-job" }; },
    provisionStatus() {
      return {
        status: "AWAITING_INVOKE_KEY",
        studio_url: "https://your-studio.studio.vivijure.com",
        endpoints: [
          { key: "backend", label: "backend", id: "abc123backend", name: "vivijure-backend-yourname" },
          { key: "upscale", label: "upscale", id: "abc123upscale", name: "vivijure-upscale-yourname" },
          { key: "lipsync", label: "lipsync", id: "abc123lipsync", name: "vivijure-musetalk-yourname" },
          { key: "audio-upscale", label: "audio-upscale", id: "abc123audio", name: "vivijure-audio-upscale-yourname" },
        ],
        steps: [
          { key: "d1", label: "Creating your database", status: "done" },
          { key: "r2", label: "Creating your storage bucket", status: "done" },
          { key: "runpod", label: "Creating your 4 RunPod endpoints", status: "done" },
          { key: "studio", label: "Deploying your studio", status: "done" },
          { key: "verify", label: "Checking it all works", status: "done" },
        ],
      };
    },
    invokeKey() {
      return {
        ok: true,
        probe: {
          graphql_denied: true,
          health: { abc123backend: true, abc123upscale: true, abc123lipsync: true, abc123audio: true },
        },
        studio_url: "https://your-studio.studio.vivijure.com",
      };
    },
  };

  // ---- rendering --------------------------------------------------------
  const $ = function (sel) { return document.querySelector(sel); };

  function renderStepper() {
    const ol = $("#stepper");
    if (!ol) return;
    const currentIdx = checks.stepIndex(current);
    ol.innerHTML = "";
    checks.STEPS.forEach(function (step, i) {
      const li = document.createElement("li");
      li.textContent = step.title;
      li.dataset.state = i < currentIdx ? "done" : i === currentIdx ? "current" : "todo";
      if (i === currentIdx) li.setAttribute("aria-current", "step");
      ol.appendChild(li);
    });
  }

  function show(stepKey) {
    current = stepKey;
    document.querySelectorAll("[data-step]").forEach(function (el) {
      el.hidden = el.dataset.step !== stepKey;
    });
    renderStepper();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function refreshGates() {
    document.querySelectorAll("[data-next]").forEach(function (btn) {
      const step = btn.dataset.next;
      if (step === "what" || step === "build") return;
      btn.disabled = !checks.canAdvance(step, state);
    });
  }

  // Renders the plan rows. Reads ONLY from the data: an endpoint added to the
  // plan grows a row here with no change to this function.
  function renderPlan(container, opts) {
    const el = typeof container === "string" ? $(container) : container;
    if (!el) return;
    el.innerHTML = "";
    if (!state.plan.length) {
      el.innerHTML = '<p class="muted small">No plan loaded.</p>';
      return;
    }
    state.plan.forEach(function (ep) {
      const row = document.createElement("div");
      row.className = "row";

      const head = document.createElement("div");
      head.className = "row-head";
      const name = document.createElement("span");
      name.className = "row-name";
      name.textContent = ep.label || ep.key;
      head.appendChild(name);

      const meta = document.createElement("span");
      meta.className = "row-meta";
      const bits = [];
      if (ep.gpu) bits.push(ep.gpu);
      if (typeof ep.max_workers === "number") {
        bits.push("max " + ep.max_workers + (ep.max_workers === 1 ? " worker" : " workers"));
      }
      bits.push("scale-to-zero");
      meta.textContent = bits.join(" -- ");
      head.appendChild(meta);
      row.appendChild(head);

      if (ep.purpose) {
        const why = document.createElement("p");
        why.className = "row-why";
        why.textContent = ep.purpose;
        row.appendChild(why);
      }
      if (ep.image && (!opts || opts.showImage !== false)) {
        const img = document.createElement("p");
        img.className = "row-why row-image";
        img.textContent = ep.image;
        row.appendChild(img);
      }
      el.appendChild(row);
    });
  }

  // The four endpoints we just created, named, so the console step is a
  // copy-match rather than guesswork (#52 ruling).
  function renderCreatedEndpoints() {
    const el = $("#created-endpoints");
    if (!el) return;
    el.innerHTML = "";
    if (!state.createdEndpoints.length) {
      el.innerHTML = '<p class="muted small">No endpoints reported yet.</p>';
      return;
    }
    state.createdEndpoints.forEach(function (ep) {
      const row = document.createElement("div");
      row.className = "row";
      const head = document.createElement("div");
      head.className = "row-head";
      const name = document.createElement("span");
      name.className = "row-name";
      name.textContent = ep.name || ep.label || ep.key;
      head.appendChild(name);
      const meta = document.createElement("span");
      meta.className = "row-meta";
      meta.textContent = "Read/Write";
      head.appendChild(meta);
      row.appendChild(head);
      if (ep.id) {
        const id = document.createElement("p");
        id.className = "row-why row-image";
        id.textContent = "id: " + ep.id;
        row.appendChild(id);
      }
      el.appendChild(row);
    });
  }

  function renderCostExample() {
    const el = $("#cost-example");
    if (!el) return;
    const ex = state.costExample;
    if (!ex) { el.textContent = ""; return; }
    const ceiling = checks.costCeilingUsd(ex.wall_clock_ms, ex.gpu_hourly_usd);
    const money = checks.formatUsd(ceiling);
    if (!money) { el.textContent = ""; return; }
    const minutes = Math.round(ex.wall_clock_ms / 60000);
    // The word "at most" is not hedging, it is the truth: wall-clock includes
    // queue and model-load time, and RunPod bills active worker seconds.
    el.textContent =
      "A real render from our own history (" + ex.description + ", " + ex.rendered_on +
      "): " + minutes + " minutes, start to finish. At the " + ex.gpu_label + " rate of $" +
      ex.gpu_hourly_usd + "/hr, that costs you at most " + money +
      ". Probably less: that clock includes queue and model-load time, and RunPod bills you for " +
      "active GPU seconds. Your studio shows your real spend after the first render.";
  }

  function renderCapacity() {
    const el = $("#capacity-result");
    if (!el) return;
    const fit = state.capacity;
    if (!fit) { el.textContent = "checking with RunPod..."; return; }

    el.innerHTML = "";
    const callout = document.createElement("div");
    callout.className = "callout " + (fit.fits ? "" : "callout-bad");

    const msg = document.createElement("p");
    msg.textContent = fit.message;
    callout.appendChild(msg);

    if (!fit.fits && fit.guidance && fit.guidance.length) {
      const what = document.createElement("p");
      what.className = "small";
      what.innerHTML = "<strong>What you can do:</strong>";
      callout.appendChild(what);
      const ul = document.createElement("ul");
      ul.className = "small muted";
      fit.guidance.forEach(function (g) {
        const li = document.createElement("li");
        li.textContent = g;
        ul.appendChild(li);
      });
      callout.appendChild(ul);
    }
    el.appendChild(callout);

    if (fit.fits) {
      const note = document.createElement("p");
      note.className = "small muted";
      note.textContent =
        "That is the number we read back from RunPod for your account, not a guess from their " +
        "published balance chart. We have seen that chart be wrong.";
      el.appendChild(note);
    }
  }

  function renderProgress(steps) {
    const ol = $("#build-progress");
    if (!ol) return;
    ol.innerHTML = "";
    (steps || []).forEach(function (s) {
      const li = document.createElement("li");
      li.dataset.status = s.status || "todo";
      const dot = document.createElement("span");
      dot.className = "dot";
      li.appendChild(dot);
      const body = document.createElement("span");
      body.textContent = s.label || s.key;
      // Honest failures: show the REAL error, never a shrug.
      if (s.status === "failed" && s.error) {
        const err = document.createElement("span");
        err.className = "step-error";
        err.textContent = s.error;
        body.appendChild(err);
      }
      li.appendChild(body);
      ol.appendChild(li);
    });
  }

  // ---- flow -------------------------------------------------------------
  async function loadPlan() {
    try {
      const data = await PlatformApi.plan();
      state.plan = (data && data.endpoints) || [];
      state.costExample = (data && data.cost_example) || null;
      renderPlan("#plan-preview");
      renderCostExample();
    } catch (err) {
      const el = $("#plan-preview");
      if (el) el.innerHTML = '<p class="hint" data-level="bad"></p>';
      const hint = el && el.querySelector(".hint");
      if (hint) hint.textContent = "Could not load the setup plan: " + err.message;
    }
  }

  async function loadAup() {
    try {
      const aup = await PlatformApi.aup();
      if (!aup || !aup.html) return; // seam stays visible; that is correct.
      const el = $("#aup-text");
      if (!el) return;
      el.classList.remove("placeholder-seam");
      el.innerHTML = aup.html;
      el.dataset.version = aup.version || "";
    } catch (err) {
      // Leave the placeholder up. Never fabricate policy text.
    }
  }

  async function runCapacityCheck() {
    state.capacity = null;
    renderCapacity();
    refreshGates();
    try {
      const data = await PlatformApi.capacity(runpodKey);
      state.capacity = checks.quotaFit(data.quota, data.existing_worker_sum, state.plan);
    } catch (err) {
      state.capacity = {
        fits: false, known: false, needed: checks.planWorkerTotal(state.plan),
        available: null, quota: null,
        message: "We could not check your account with RunPod: " + err.message,
        guidance: ["Check the key you pasted is complete, and that its graphql access is Read/Write."],
      };
    }
    renderCapacity();
    refreshGates();
  }

  async function runProvision() {
    renderProgress([{ key: "start", label: "Starting setup", status: "running" }]);
    try {
      const job = await PlatformApi.provision(runpodKey);
      state.provisionJobId = job.job_id;
      const status = await PlatformApi.provisionStatus(job.job_id);
      renderProgress(status.steps);

      state.studioUrl = status.studio_url || state.studioUrl;
      state.createdEndpoints = status.endpoints || [];

      // The endpoints exist, so key A has done its whole job. It stops existing
      // here, BEFORE the tenant is asked for key B: we never hold both at once.
      // (This is also why a failed RunPod step cannot self-resume -- we have
      // nothing to resume with. The honest cost of not storing it.)
      if (status.status === "AWAITING_INVOKE_KEY" || status.status === "COMPLETED") {
        clearKey();
      }

      if (status.status === "AWAITING_INVOKE_KEY") {
        renderCreatedEndpoints();
        show("invoke");
        return;
      }

      if (status.status === "COMPLETED") {
        // A control plane that skipped the key-B phase is a contract change,
        // not a shortcut to take quietly.
        finishAndShowDone();
        return;
      }

      const cont = $("#build-continue");
      if (cont) cont.hidden = false;
    } catch (err) {
      // Ruled on #52: because we never store key A, a RunPod-step failure
      // cannot self-resume. Retry answers 409 runpod_key_required and the
      // tenant re-pastes. Say that plainly instead of a dead end.
      const needsKey = /runpod_key_required|\b409\b/.test(err.message || "");
      renderProgress([{
        key: "start",
        label: needsKey ? "Setup needs your key again" : "Setup could not finish",
        status: "failed",
        error: err.message,
      }]);
      if (needsKey) {
        const note = $("#build-progress");
        if (note) {
          const p = document.createElement("p");
          p.className = "small muted";
          p.textContent =
            "We never stored your setup key, so we cannot retry this on our own. That is the " +
            "tradeoff for not holding it. Go back and paste it again to pick up where this left off.";
          note.appendChild(p);
        }
      }
      const cont = $("#build-continue");
      if (cont) { cont.hidden = false; cont.textContent = "Back to the key step"; }
    }
  }

  function finishAndShowDone() {
    clearKey();
    clearInvokeKey();
    const link = $("#studio-link");
    if (link && state.studioUrl) {
      link.href = state.studioUrl;
      link.textContent = "Open my studio: " + state.studioUrl;
    }
    show("done");
  }

  // Key B: verify scope LIVE, then keep it. Never keep it on a failed verdict.
  async function runInvokeKeyCheck() {
    const verdictEl = $("#invoke-verdict");
    if (verdictEl) verdictEl.innerHTML = '<p class="small muted">Checking that key against your endpoints...</p>';
    state.invokeVerified = false;
    refreshGates();

    let verdict;
    try {
      const res = await PlatformApi.invokeKey(state.provisionJobId, invokeKey);
      verdict = checks.scopeVerdict(res.probe);
      if (res.studio_url) state.studioUrl = res.studio_url;
    } catch (err) {
      verdict = { ok: false, failures: [err.message], message: err.message };
    }

    state.invokeVerified = verdict.ok;
    if (!verdict.ok) {
      // Rejected keys are not kept, here or anywhere. Clear the field so a bad
      // key does not sit in the DOM waiting to be pasted somewhere worse.
      clearInvokeKey();
      const input = $("#invoke-key");
      if (input) input.value = "";
    }

    if (verdictEl) {
      verdictEl.innerHTML = "";
      const callout = document.createElement("div");
      callout.className = "callout " + (verdict.ok ? "" : "callout-bad");
      verdict.ok
        ? callout.appendChild(textP(verdict.message))
        : verdict.failures.forEach(function (f) { callout.appendChild(textP(f)); });
      verdictEl.appendChild(callout);
    }
    refreshGates();
  }

  function textP(text) {
    const p = document.createElement("p");
    p.textContent = text;
    return p;
  }

  // ---- wiring -----------------------------------------------------------
  function wire() {
    if (USE_MOCK) {
      const banner = $("#mock-banner");
      if (banner) banner.hidden = false;
    }

    const accept = $("#accept-aup");
    if (accept) {
      accept.addEventListener("change", function () {
        state.rulesAccepted = accept.checked;
        refreshGates();
      });
    }

    const keyInput = $("#runpod-key");
    const keyHint = $("#key-hint");
    if (keyInput) {
      keyInput.addEventListener("input", function () {
        runpodKey = keyInput.value.trim();
        const hint = checks.keyShapeHint(runpodKey);
        if (keyHint) {
          keyHint.textContent = hint.message;
          keyHint.dataset.level = hint.level === "empty" ? "" : hint.level;
        }
        state.keyPresent = runpodKey.length > 0;
        refreshGates();
      });
    }

    const reveal = $("#key-reveal");
    if (reveal && keyInput) {
      reveal.addEventListener("click", function () {
        const showing = keyInput.type === "text";
        keyInput.type = showing ? "password" : "text";
        reveal.textContent = showing ? "Show" : "Hide";
        reveal.setAttribute("aria-pressed", String(!showing));
      });
    }

    const confirm = $("#confirm-create");
    if (confirm) {
      confirm.addEventListener("change", function () {
        state.confirmed = confirm.checked;
        refreshGates();
      });
    }

    const invokeInput = $("#invoke-key");
    const invokeHint = $("#invoke-hint");
    if (invokeInput) {
      invokeInput.addEventListener("input", function () {
        invokeKey = invokeInput.value.trim();
        const hint = checks.keyShapeHint(invokeKey);
        if (invokeHint) {
          invokeHint.textContent = hint.message;
          invokeHint.dataset.level = hint.level === "empty" ? "" : hint.level;
        }
        // Editing the key invalidates any earlier verdict: never let a verified
        // flag outlive the key it was about.
        state.invokeVerified = false;
        refreshGates();
      });
    }
    const invokeReveal = $("#invoke-reveal");
    if (invokeReveal && invokeInput) {
      invokeReveal.addEventListener("click", function () {
        const showing = invokeInput.type === "text";
        invokeInput.type = showing ? "password" : "text";
        invokeReveal.textContent = showing ? "Show" : "Hide";
        invokeReveal.setAttribute("aria-pressed", String(!showing));
      });
    }
    const invokeCheck = $("#invoke-check");
    if (invokeCheck) {
      invokeCheck.addEventListener("click", function () {
        if (invokeKey) runInvokeKeyCheck();
      });
    }

    document.querySelectorAll("[data-next]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const from = btn.dataset.next;
        if (from !== "what" && from !== "build" && !checks.canAdvance(from, state)) return;

        if (from === "rules") {
          const version = ($("#aup-text") || {}).dataset ? $("#aup-text").dataset.version : "";
          try { await PlatformApi.acceptAup(version || null); } catch (err) { /* surfaced on the server */ }
        }

        if (from === "invoke") { finishAndShowDone(); return; }

        const idx = checks.stepIndex(from);
        const next = checks.STEPS[idx + 1];
        if (!next) return;
        show(next.key);

        if (next.key === "capacity") runCapacityCheck();
        if (next.key === "review") { renderPlan("#plan-review"); renderTotal(); }
        if (next.key === "build") runProvision();
      });
    });

    document.querySelectorAll("[data-back]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const idx = checks.stepIndex(btn.dataset.back);
        const prev = checks.STEPS[idx - 1];
        if (prev) show(prev.key);
      });
    });
  }

  function renderTotal() {
    const el = $("#plan-total");
    if (!el) return;
    const total = checks.planWorkerTotal(state.plan);
    const fit = state.capacity;
    let text = "Total: " + total + (total === 1 ? " worker" : " workers") + " at most, across " +
      state.plan.length + " endpoints, all scale-to-zero.";
    if (fit && fit.known && typeof fit.quota === "number") {
      text += " Your account's real quota is " + fit.quota + ".";
    }
    el.textContent = text;
  }

  function init() {
    if (!checks) return;
    wire();
    show("what");
    refreshGates();
    loadPlan();
    loadAup();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
