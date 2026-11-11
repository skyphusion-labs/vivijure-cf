// Make a video (cf#1242): one screen, top to bottom, for a first-time creator. Every step uses a
// route the planner and cast page already use; nothing here is a new API.
//
//   who      GET /api/cast; add = POST /api/cast, POST /api/upload, POST /api/cast/:id/portrait,
//            POST /api/cast/:id/generate-refs (+ GET refs-job), GET /api/cast/:id/lora-status
//   style    GET /api/modules through moduleRegistry, decided by make-style.js (the face rule)
//   voices   for a plan that talks: GET /api/voices, PATCH /api/cast/:id { voice_id } (no voice yet)
//   plan     POST /api/storyboard/plan with the first planning model GET /api/storyboard/models lists
//   save     POST /api/storyboard/projects, then POST /api/storyboard/projects/:id/storyboard
//   make     POST /api/storyboard/bundle, then POST /api/storyboard/render (the planner's film door)
//   watch    GET /api/storyboard/render/:jobId, read with renderEta, until a final state
//
// Copy on this page is plain words: the jargon list in the PR body (and docs/make-a-video.md) is
// what tests/browser/make-video.mjs checks the rendered text against.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const style = window.makeStyle;
  const SLOTS = ["A", "B", "C", "D"];
  const MAX_PEOPLE = 4;
  const RUN_KEY = "skyphusion.make.run";
  // How long face prep takes, as the cast page already tells people (public/cast.js).
  const PREP_MINUTES = { refs: "2-4", look: "15-25", wan: "35-45" };

  const state = {
    reg: null,
    cast: [],
    wanTrainable: false,
    planModel: "",
    chosen: [], // cast ids, in order
    prep: {}, // cast id -> { words, busy, failed }
    shape: style.DEFAULT_SHAPE,
    quality: "good",
    board: null,
    choice: null,
    running: false,
  };

  // ---------- small helpers ----------

  async function getJson(path) {
    const r = await fetch(path, { headers: { accept: "application/json" } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error((body && body.error) || "the studio answered " + r.status);
      err.status = r.status;
      throw err;
    }
    return body;
  }

  async function postJson(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || (out && out.ok === false)) {
      const msg = (out && (out.error || (Array.isArray(out.errors) && out.errors.join("; ")))) || "the studio answered " + r.status;
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return out;
  }

  function artifactUrl(key) {
    if (!key) return "";
    return /^https?:\/\//i.test(key) ? key : "/api/artifact/" + key;
  }

  function findCast(id) {
    return state.cast.find((c) => c.id === id) || null;
  }

  function putCast(row) {
    if (!row || !row.id) return;
    const i = state.cast.findIndex((c) => c.id === row.id);
    if (i >= 0) state.cast[i] = row;
    else state.cast.unshift(row);
  }

  function imageKeys(c) {
    const keys = [];
    const push = (k) => {
      const v = typeof k === "string" ? k : k && k.key;
      if (v && keys.indexOf(v) === -1) keys.push(v);
    };
    if (c && c.portrait_key) push(c.portrait_key);
    for (const r of (c && c.ref_keys) || []) push(r);
    for (const r of (c && c.source_keys) || []) push(r);
    return keys;
  }

  function hasWanLook(c) {
    return !!(c && c.wan_lora_key_high && c.wan_lora_key_low);
  }

  function stillsTrainLook() {
    const still = state.reg ? style.stillsDoor(state.reg) : null;
    return !!(still && still.trains_loras === true);
  }

  // Ready means the studio can draw this person now. Waiting on the trained look only matters when
  // the stills door uses it; otherwise the photos are enough.
  function faceReady(c) {
    if (!c || !c.portrait_key) return false;
    const p = state.prep[c.id];
    if (p && p.busy) return false;
    if (!Array.isArray(c.ref_keys) || c.ref_keys.length === 0) return false;
    if (stillsTrainLook() && c.lora_status === "training") return false;
    return true;
  }

  // A person is BOUND to the video (castLoras) only when the server will accept it: a stills door
  // that trains the look refuses a person whose look is not ready. An unbound person speaks in the
  // studio's one default voice, so "voices ready" means every person can be bound.
  function bindable(c) {
    return !!c && (!stillsTrainLook() || c.lora_status === "ready");
  }

  function hostFacts() {
    const people = state.chosen.map(findCast).filter(Boolean);
    return {
      wanTrainable: state.wanTrainable,
      wanReady: people.length > 0 && people.every(hasWanLook),
      voicesReady: people.every(bindable),
    };
  }

  // ---------- who's in it ----------

  function renderPeople() {
    const chosen = $("make-chosen");
    chosen.textContent = "";
    for (const id of state.chosen) {
      const c = findCast(id);
      if (!c) continue;
      const li = document.createElement("li");
      li.className = "make-person";
      const img = document.createElement("img");
      img.alt = "";
      img.src = artifactUrl(c.portrait_key);
      const meta = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = c.name;
      const words = document.createElement("span");
      words.className = "make-hint";
      const p = state.prep[c.id];
      words.textContent = p && p.words ? p.words : faceReady(c) ? "Face ready" : "Face not ready yet";
      if (p && p.failed) words.className = "make-warn";
      meta.append(name, words);
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "make-drop";
      drop.textContent = "Remove";
      drop.setAttribute("aria-label", "Remove " + c.name);
      drop.addEventListener("click", () => {
        state.chosen = state.chosen.filter((x) => x !== id);
        refresh();
      });
      li.append(img, meta, drop);
      chosen.append(li);
    }

    const faces = $("make-faces");
    faces.textContent = "";
    for (const c of state.cast) {
      if (!c.portrait_key || state.chosen.indexOf(c.id) !== -1) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "make-face";
      b.title = c.name;
      b.setAttribute("aria-label", "Add " + c.name);
      const img = document.createElement("img");
      img.alt = "";
      img.src = artifactUrl(c.portrait_key);
      const span = document.createElement("span");
      span.textContent = c.name;
      b.append(img, span);
      b.disabled = state.chosen.length >= MAX_PEOPLE;
      b.addEventListener("click", () => choosePerson(c.id));
      faces.append(b);
    }
    $("make-add").hidden = state.chosen.length >= MAX_PEOPLE;
  }

  function choosePerson(id) {
    if (state.chosen.length >= MAX_PEOPLE || state.chosen.indexOf(id) !== -1) return;
    state.chosen.push(id);
    const c = findCast(id);
    // A person picked from the list may have only a portrait. Start the same face prep as Add.
    if (c && (!Array.isArray(c.ref_keys) || c.ref_keys.length === 0)) prepareFace(c);
    else if (c && stillsTrainLook() && c.lora_status === "training") watchLook(c);
    refresh();
  }

  async function addSomeone() {
    const name = $("make-add-name").value.trim();
    const file = $("make-add-photo").files && $("make-add-photo").files[0];
    const note = $("make-add-note");
    if (!name) { note.textContent = "Type their name first."; return; }
    if (!file) { note.textContent = "Pick one selfie."; return; }
    if (state.chosen.length >= MAX_PEOPLE) { note.textContent = "A video can have up to 4 people."; return; }
    $("make-add-go").disabled = true;
    note.textContent = "Adding " + name + "...";
    try {
      const created = await postJson("/api/cast", { name });
      let c = created.cast;
      putCast(c);
      const up = await fetch("/api/upload", { method: "POST", headers: { "content-type": file.type || "image/jpeg" }, body: file });
      const upBody = await up.json().catch(() => ({}));
      if (!up.ok || !upBody.key) throw new Error(upBody.error || "the photo did not upload");
      const withFace = await postJson("/api/cast/" + encodeURIComponent(c.id) + "/portrait", { from_chat_artifact: upBody.key });
      c = withFace.cast || c;
      putCast(c);
      state.chosen.push(c.id);
      $("make-add-name").value = "";
      $("make-add-photo").value = "";
      $("make-add").open = false;
      note.textContent = "";
      prepareFace(c);
    } catch (e) {
      note.textContent = "Could not add " + name + ": " + e.message;
    } finally {
      $("make-add-go").disabled = false;
      refresh();
    }
  }

  function setPrep(id, words, extra) {
    state.prep[id] = Object.assign({ words, busy: true, failed: false }, extra || {});
    refresh();
  }

  // Refs, then the trained look where the stills door uses one. The refs job starts that training by
  // itself once enough pictures exist (docs/CONTRACT.md 2.8, lora_job_id).
  async function prepareFace(c) {
    setPrep(c.id, "Getting " + c.name + "'s face ready (about " + PREP_MINUTES.refs + " min)");
    let job;
    try {
      job = await postJson("/api/cast/" + encodeURIComponent(c.id) + "/generate-refs", {});
    } catch (e) {
      setPrep(c.id, "Could not get " + c.name + "'s face ready: " + e.message, { busy: false, failed: true });
      return;
    }
    const jobId = job.job_id;
    let errors = 0;
    const loop = window.pollSchedule.createLoop({
      baseMs: 3000,
      isActive: () => !!(state.prep[c.id] && state.prep[c.id].busy && state.prep[c.id].stage === "refs"),
      run: async () => {
        try {
          job = await getJson("/api/cast/" + encodeURIComponent(c.id) + "/refs-job/" + encodeURIComponent(jobId));
          errors = 0;
        } catch (_) {
          errors += 1;
          if (errors > 5) {
            setPrep(c.id, "Lost track of " + c.name + "'s face. Remove them and add them again.", { busy: false, failed: true });
            loop.destroy();
            return;
          }
          loop.armAfterError();
          return;
        }
        if (job.phase === "generating") { loop.armAfterSuccess(); return; }
        loop.destroy();
        if (job.phase === "failed") {
          setPrep(c.id, "Could not get " + c.name + "'s face ready: " + (job.error || "it stopped"), { busy: false, failed: true });
          return;
        }
        const fresh = await getJson("/api/cast/" + encodeURIComponent(c.id)).catch(() => null);
        if (fresh && fresh.cast) putCast(fresh.cast);
        const row = findCast(c.id);
        if (stillsTrainLook() && (job.lora_job_id || (row && row.lora_status === "training"))) watchLook(row);
        else { delete state.prep[c.id]; refresh(); }
      },
    });
    state.prep[c.id].stage = "refs";
    loop.arm();
  }

  function watchLook(c) {
    if (!c) return;
    setPrep(c.id, "Learning " + c.name + "'s face (about " + PREP_MINUTES.look + " min)", { stage: "look" });
    const loop = window.pollSchedule.createLoop({
      baseMs: 20000,
      isActive: () => !!(state.prep[c.id] && state.prep[c.id].busy && state.prep[c.id].stage === "look"),
      run: async () => {
        let data;
        try {
          data = await getJson("/api/cast/" + encodeURIComponent(c.id) + "/lora-status");
        } catch (_) {
          loop.armAfterError();
          return;
        }
        if (data && data.cast) putCast(data.cast);
        const row = findCast(c.id);
        if (row && row.lora_status === "training") { loop.armAfterSuccess(); return; }
        loop.destroy();
        if (row && row.lora_status === "failed") {
          setPrep(c.id, "Could not learn " + c.name + "'s face. Their photos still work.", { busy: false, failed: false });
        } else {
          delete state.prep[c.id];
        }
        refresh();
      },
    });
    loop.arm();
  }

  // ---------- shape, quality, style, total ----------

  function radio(group, value, label, hint, checked, onPick) {
    const id = group + "-" + value;
    const wrap = document.createElement("label");
    wrap.className = "make-option";
    wrap.htmlFor = id;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = group;
    input.id = id;
    input.value = value;
    input.checked = checked;
    input.addEventListener("change", () => { if (input.checked) onPick(value); });
    const text = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = label;
    const small = document.createElement("small");
    small.textContent = hint;
    text.append(strong, small);
    wrap.append(input, text);
    return wrap;
  }

  function renderShapes() {
    const host = $("make-shapes");
    host.textContent = "";
    const shapes = style.offeredShapes(state.reg, { host: hostFacts() });
    if (!shapes.some((s) => s.id === state.shape)) state.shape = shapes.length ? shapes[0].id : "";
    for (const s of shapes) {
      host.append(radio("make-shape", s.id, s.label, s.hint, s.id === state.shape, (v) => { state.shape = v; refresh(); }));
    }
    return shapes;
  }

  function priceHint(q) {
    const pick = style.chooseStyle(state.reg, { shape: state.shape, quality: q.id, host: hostFacts() });
    if (!pick) return "price unknown";
    const seconds = state.board ? style.sceneSeconds(state.board) : 0;
    const p = style.clipPrice(pick.door, seconds, q.id);
    if (p.usd !== null) return style.priceText(p);
    if (p.kind === "per_clip") return "priced per clip, shown once your idea is planned";
    if (p.kind === "per_second") return (p.exact ? "about $" : "up to $") + (p.perSecond * 10).toFixed(2) + " for each 10 seconds";
    return "price unknown";
  }

  function renderQualities() {
    const host = $("make-qualities");
    host.textContent = "";
    const qs = style.offeredQualities(state.reg);
    if (!qs.some((q) => q.id === state.quality)) state.quality = qs.length ? qs[qs.length - 1].id : "";
    for (const q of qs) {
      // Time is not measured anywhere this page can read before a first video, so it says so.
      host.append(radio("make-quality", q.id, q.label, priceHint(q) + ". Time not known yet.", q.id === state.quality, (v) => { state.quality = v; refresh(); }));
    }
  }

  function talksNow() {
    return state.board ? style.hasSpokenLines(state.board) : null;
  }

  function renderStyleAndTotal() {
    state.choice = state.shape
      ? style.chooseStyle(state.reg, { shape: state.shape, quality: state.quality, talks: talksNow(), host: hostFacts() })
      : null;
    $("make-style-line").textContent = state.choice ? "Style: " + state.choice.line : "Style: none here keeps faces consistent";
    const total = $("make-total");
    const note = $("make-total-note");
    if (!state.choice) {
      total.textContent = "price unknown";
      note.textContent = "";
      return;
    }
    if (!state.board) {
      total.textContent = "Shown after your idea is planned";
      note.textContent = "You see the total before anything starts.";
      return;
    }
    const p = style.clipPrice(state.choice.door, style.sceneSeconds(state.board), state.quality);
    total.textContent = style.priceText(p);
    // cf#1246: at cost until an end-user markup is set (Conrad, 2026-11-05).
    note.textContent = p.usd === null
      ? "This style states no price for these scenes, so the studio cannot give a total."
      : "At cost: what the video service charges for the moving video, with nothing added. Pictures and voices are not priced here.";
  }

  function blockers() {
    const out = [];
    if (!state.reg) return ["Loading..."];
    if (state.running) return ["Your video is being made."];
    if (!state.chosen.length) out.push("Add at least one person.");
    const waiting = state.chosen.map(findCast).filter((c) => c && !faceReady(c));
    if (waiting.length) out.push("Waiting for " + waiting.map((c) => c.name).join(", ") + (waiting.length === 1 ? "'s face" : "'s faces") + " to be ready.");
    if (!$("make-idea").value.trim()) out.push("Write your idea.");
    if (!state.shape) out.push("No shape here keeps faces consistent.");
    if (!state.choice) out.push("No video style here keeps faces consistent for this choice.");
    if (!state.planModel) out.push("This studio cannot write a plan right now.");
    return out;
  }

  function refresh() {
    if (!state.reg) return;
    renderPeople();
    renderShapes();
    renderQualities();
    renderStyleAndTotal();
    const list = blockers();
    $("make-why").textContent = list.join(" ");
    $("make-go").disabled = list.length > 0;
  }

  // ---------- make ----------

  function characters() {
    return state.chosen.map(findCast).filter(Boolean).map((c, i) => ({ slot: SLOTS[i], name: c.name, bible: c.bible || "" }));
  }

  function showProgress(words, fraction) {
    $("make-form").hidden = true;
    $("make-progress").hidden = false;
    $("make-progress-words").textContent = words;
    if (typeof fraction === "number") {
      const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
      $("make-bar-fill").style.width = pct + "%";
      $("make-bar").setAttribute("aria-valuenow", String(pct));
    }
  }

  function showFailure(words) {
    state.running = false;
    clearRun();
    $("make-progress-error").hidden = false;
    $("make-progress-error").textContent = words;
    $("make-again").hidden = false;
  }

  async function startMaking() {
    const why = $("make-why");
    why.textContent = "Writing a plan from your idea (5 to 30 seconds)...";
    $("make-go").disabled = true;
    let planned;
    try {
      planned = await postJson("/api/storyboard/plan", { brief: $("make-idea").value.trim(), characters: characters(), model: state.planModel });
    } catch (e) {
      why.textContent = "Could not write a plan: " + e.message + ". Try rewording your idea.";
      $("make-go").disabled = false;
      return;
    }
    state.board = planned.storyboard;
    refresh();
    if (!state.choice) {
      why.textContent = style.hasSpokenLines(state.board)
        ? "Your video has people talking, and no talking style here keeps faces consistent in this shape. Try another shape, or the advanced planner."
        : "No style here keeps faces consistent in this shape.";
      return;
    }
    await askConfirm();
  }

  // cf#1067: the studio's own length check for this style, in plain words, before anything starts. A
  // failed check does not stop the video; it says the lengths could not be checked.
  async function lengthNotes() {
    try {
      // Not postJson: preflight answers ok:false when a shot is too long, and that is the answer wanted here.
      const r = await fetch("/api/storyboard/preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storyboard: state.board, motion_backend: state.choice.door.name, quality: state.quality }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const out = await r.json();
      return (Array.isArray(out.issues) ? out.issues : []).map(style.lengthNote).filter(Boolean);
    } catch (_) {
      return ["The studio could not check how long each scene will be."];
    }
  }

  async function askConfirm() {
    const seconds = style.boardSeconds(state.board);
    const shape = style.SHAPES.find((s) => s.id === state.shape);
    const quality = style.QUALITIES.find((q) => q.id === state.quality);
    $("make-confirm-what").textContent = "About " + Math.round(seconds) + " seconds, " + shape.label.toLowerCase() + ", " + quality.label.toLowerCase() + " quality, with " + characters().map((c) => c.name).join(", ") + ".";
    const talking = style.talkingStyleLine(state.board, state.choice.door);
    $("make-confirm-style").textContent = "Style: " + state.choice.line + "." + (talking ? " " + talking : "");
    $("make-confirm-total").textContent = "Total: " + $("make-total").textContent;
    $("make-confirm-note").textContent = $("make-total-note").textContent;
    const needWan = state.choice.needs === "wan_lora" ? state.chosen.map(findCast).filter((c) => c && !hasWanLook(c)) : [];
    const voiceless = style.hasSpokenLines(state.board) ? state.chosen.map(findCast).filter(needsVoice) : [];
    $("make-confirm-faces").textContent = [
      needWan.length ? "First this style learns " + needWan.map((c) => c.name).join(", ") + "'s face (about " + PREP_MINUTES.wan + " min each)." : "",
      voiceless.length ? voiceless.map((c) => c.name).join(", ") + (voiceless.length === 1 ? " gets a voice of their own. You can change it on the Cast page." : " each get a voice of their own. You can change them on the Cast page.") : "",
    ].filter(Boolean).join(" ");
    const lengths = $("make-confirm-lengths");
    lengths.textContent = "";
    const notes = await lengthNotes();
    for (const n of notes) {
      const li = document.createElement("li");
      li.textContent = n;
      lengths.append(li);
    }
    lengths.hidden = notes.length === 0;
    $("make-confirm").showModal();
  }

  function saveRun(run) {
    try { sessionStorage.setItem(RUN_KEY, JSON.stringify(run)); } catch (_) {}
  }
  function readRun() {
    try { return JSON.parse(sessionStorage.getItem(RUN_KEY) || "null"); } catch (_) { return null; }
  }
  function clearRun() {
    try { sessionStorage.removeItem(RUN_KEY); } catch (_) {}
  }

  // The board goes into a project of its own, so "Edit in advanced planner" has something to open.
  async function saveBoard() {
    const title = (state.board && (state.board.title || state.board.projectName)) || $("make-idea").value.trim().slice(0, 40) || "My video";
    try {
      const made = await postJson("/api/storyboard/projects", { name: String(title).slice(0, 80) });
      const project = made.project;
      await postJson("/api/storyboard/projects/" + encodeURIComponent(project.id) + "/storyboard", { storyboard: state.board });
      return project;
    } catch (e) {
      return { error: e.message };
    }
  }

  // Everyone who talks needs a voice of their own. A person with none would speak in the studio's
  // one default voice, the same as everyone else, so each gets the next unused one from
  // GET /api/voices, saved on them (PATCH /api/cast/:id voice_id) where the cast page shows it.
  function needsVoice(c) {
    return !!c && !c.voice_id;
  }

  async function giveVoices(people) {
    const lacking = people.filter(needsVoice);
    if (!lacking.length) return;
    showProgress("Giving everyone their own voice", 0.02);
    const data = await getJson("/api/voices");
    const ids = (Array.isArray(data.voices) ? data.voices : []).map((v) => v && v.id).filter(Boolean);
    const used = new Set(people.map((c) => c.voice_id).filter(Boolean));
    for (const c of lacking) {
      const id = ids.find((v) => !used.has(v));
      if (!id) throw new Error("there are not enough voices for everyone");
      used.add(id);
      const r = await fetch("/api/cast/" + encodeURIComponent(c.id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voice_id: id }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.cast) throw new Error("could not give " + c.name + " a voice");
      putCast(out.cast);
    }
  }

  async function learnWanLooks(people) {
    for (const c of people) {
      showProgress("Learning " + c.name + "'s face for this style (about " + PREP_MINUTES.wan + " min)", 0.02);
      await postJson("/api/cast/" + encodeURIComponent(c.id) + "/train-wan-lora", {});
      await new Promise((resolve, reject) => {
        let settled = false;
        const loop = window.pollSchedule.createLoop({
          baseMs: 30000,
          isActive: () => !settled,
          run: async () => {
            const data = await getJson("/api/cast/" + encodeURIComponent(c.id) + "/lora-status").catch(() => null);
            if (!data) { loop.armAfterError(); return; }
            if (data.cast) putCast(data.cast);
            const row = findCast(c.id);
            if (hasWanLook(row)) { settled = true; loop.destroy(); resolve(); return; }
            if (row && row.lora_status === "failed") { settled = true; loop.destroy(); reject(new Error("could not learn " + c.name + "'s face")); return; }
            loop.armAfterSuccess();
          },
        });
        loop.arm();
      });
    }
  }

  async function make() {
    state.running = true;
    refresh();
    const choice = state.choice;
    const people = state.chosen.map(findCast).filter(Boolean);
    showProgress("Saving your plan", 0.01);
    const project = await saveBoard();
    try {
      if (choice.needs === "wan_lora") await learnWanLooks(people.filter((c) => !hasWanLook(c)));
      if (style.hasSpokenLines(state.board)) await giveVoices(people);
      showProgress("Getting everyone's faces ready", 0.02);
      const characterRefs = {};
      const castLoras = {};
      people.forEach((c, i) => {
        const row = findCast(c.id) || c;
        characterRefs[SLOTS[i]] = { name: row.name, prompt: row.bible || "", trainingImages: imageKeys(row).map((key) => ({ key })) };
        // Bind only what the server accepts (see bindable): a bound look that is not ready fails the
        // video when the stills door uses the look. The binding also carries the person's voice.
        if (bindable(row)) castLoras[SLOTS[i]] = row.id;
      });
      const packed = await postJson("/api/storyboard/bundle", { storyboard: state.board, characterRefs });
      const config = {};
      config[choice.door.name] = choice.motionConfig;
      if (choice.still) config[choice.still.name] = choice.stillConfig;
      const scenes = (state.board.scenes || []).map((s, i) => {
        const prompt = typeof s.prompt === "string" ? s.prompt.trim() : "";
        if (!prompt) return null;
        const clip = typeof state.board.clip_seconds === "number" && state.board.clip_seconds > 0 ? state.board.clip_seconds : 4;
        const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : "shot_" + String(i + 1).padStart(2, "0");
        return { shot_id: id, prompt, seconds: typeof s.target_seconds === "number" && s.target_seconds > 0 ? s.target_seconds : clip };
      }).filter(Boolean);
      const body = {
        bundleKey: packed.bundleKey,
        scenes,
        motion_backend: choice.door.name,
        renderOverrides: { motion_backend: choice.door.name, keyframe_backend: choice.still ? choice.still.name : undefined, config },
        idempotency_key: "make-" + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      };
      const tier = style.QUALITIES.find((q) => q.id === state.quality);
      if (tier) body.qualityTier = tier.tier;
      if (Object.keys(castLoras).length) body.castLoras = castLoras;
      if (project && project.id) body.projectId = project.id;
      if (state.board.style_prefix) body.style_prefix = state.board.style_prefix;
      showProgress("Starting", 0.03);
      let started;
      try {
        started = await postJson("/api/storyboard/render", body);
      } catch (e) {
        // One retry on a studio error, with the SAME key, so a lost answer never starts two videos.
        if (!(e.status >= 500)) throw e;
        started = await postJson("/api/storyboard/render", body);
      }
      if (!started.jobId) throw new Error("the studio did not say it started");
      const run = { jobId: started.jobId, startedAt: Date.now(), project: project && project.id ? { id: project.id, name: project.name } : null, saveError: project && project.error ? project.error : "" };
      saveRun(run);
      askToNotify();
      watch(run);
    } catch (e) {
      showFailure("Your video did not start: " + e.message + ". Nothing was made.");
    }
  }

  // ---------- watch ----------

  const PLAIN_PHASE = {
    queued: "Waiting to start",
    keyframe: "Drawing the pictures",
    pre_clip_dialogue: "Recording the voices",
    pre_clip_speech: "Cleaning up the voices",
    i2v: "Bringing the pictures to life",
    clips: "Bringing the pictures to life",
    shards: "Bringing the pictures to life",
    finish: "Polishing",
    gather: "Putting it together",
    finishing: "Putting it together",
    assemble: "Putting it together",
    mux: "Adding sound",
  };

  function phaseWords(view) {
    const out = (view && view.output) || {};
    const key = typeof out.phase === "string" && out.phase ? out.phase.toLowerCase() : view && view.statusRaw === "queued" ? "queued" : "";
    if (window.renderEta && window.renderEta.isStalled(view)) return "This is taking longer than it should. It may need a look in the advanced planner.";
    if (window.renderEta && window.renderEta.isStartupWindow(view)) return "Starting up. The first minutes are the slowest.";
    return PLAIN_PHASE[key] || "Working on it";
  }

  function etaWords(fraction, startedAt) {
    if (!window.renderEta) return "";
    const ms = window.renderEta.remainingMs(fraction, Date.now() - startedAt);
    if (ms === null) return "Working out how long this takes...";
    const min = Math.max(1, Math.round(ms / 60000));
    return "About " + min + " min left. You can leave this page open, or come back later.";
  }

  function watch(run) {
    state.running = true;
    showProgress("Waiting to start", 0.03);
    let done = false;
    const loop = window.pollSchedule.createLoop({
      isActive: () => !done,
      maxErrorStreak: 20,
      onGiveUp: () => showFailure("Lost touch with the studio. Your video may still finish; check the advanced planner."),
      run: async () => {
        let view;
        try {
          view = await getJson("/api/storyboard/render/" + encodeURIComponent(run.jobId));
        } catch (_) {
          loop.armAfterError();
          return;
        }
        const fraction = window.renderEta ? window.renderEta.progressFraction(view.output) : null;
        showProgress(phaseWords(view), typeof fraction === "number" ? Math.max(0.03, fraction) : undefined);
        $("make-progress-eta").textContent = typeof fraction === "number" ? etaWords(fraction, run.startedAt) : "";
        const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].indexOf(view.status) !== -1;
        if (!terminal) { loop.armAfterSuccess(); return; }
        done = true;
        loop.destroy();
        finished(run, view);
      },
    });
    loop.arm();
  }

  function finished(run, view) {
    state.running = false;
    clearRun();
    notify(view.status === "COMPLETED" ? "Your video is ready" : "Your video did not finish");
    const out = view.output || {};
    const fd = window.finishDegrade;
    const deliv = fd ? fd.deliverable(out) : { kind: out.output_key ? "film" : "none", key: out.output_key || null };
    if (view.status !== "COMPLETED" || deliv.kind !== "film") {
      showFailure("Your video did not finish" + (view.error ? ": " + String(view.error).slice(0, 200) : ".") + " Open the advanced planner to see what happened.");
      return;
    }
    $("make-progress").hidden = true;
    $("make-result").hidden = false;
    const url = artifactUrl(deliv.key);
    $("make-player").src = url;
    $("make-download").href = url;
    const degrade = fd && fd.degradeFrom ? fd.degradeFrom(out) : null;
    const notes = [];
    if (degrade) notes.push("Some polish could not run, so parts of this video are less sharp than planned.");
    // cf#916 / cf#1282: the picture check and the extra person check, in plain words.
    if (fd && fd.simpleWarnings) notes.push(...fd.simpleWarnings(out));
    const noteBox = $("make-result-note");
    noteBox.textContent = "";
    for (const line of notes) {
      const p = document.createElement("p");
      p.className = "make-warn";
      p.textContent = line;
      noteBox.appendChild(p);
    }
    noteBox.hidden = notes.length === 0;
    $("make-saved").textContent = run.project
      ? "Saved as \"" + run.project.name + "\". Open it from the advanced planner to change anything."
      : "Could not save a copy for the advanced planner" + (run.saveError ? ": " + run.saveError : ".");
  }

  // The planner's pattern (planner-init.js): ask once, at the moment the wait starts.
  function askToNotify() {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    Notification.requestPermission().catch(() => {});
  }
  function notify(title) {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try { new Notification(title, { icon: "/apple-touch-icon.png" }); } catch (_) {}
  }

  // ---------- start ----------

  async function init() {
    $("make-add-go").addEventListener("click", addSomeone);
    $("make-idea").addEventListener("input", () => { state.board = null; refresh(); });
    $("make-go").addEventListener("click", startMaking);
    $("make-confirm").addEventListener("close", () => {
      if ($("make-confirm").returnValue === "go") make();
      else { $("make-why").textContent = "Nothing started."; $("make-go").disabled = false; }
    });
    $("make-again").addEventListener("click", () => location.reload());

    const [reg, castRes, models] = await Promise.all([
      window.moduleRegistry.load(),
      getJson("/api/cast").catch(() => ({})),
      getJson("/api/storyboard/models").catch(() => ({})),
    ]);
    state.reg = reg;
    state.cast = Array.isArray(castRes.cast) ? castRes.cast : [];
    state.wanTrainable = castRes.wan_lora_trainable === true;
    const list = Array.isArray(models.models) ? models.models : [];
    state.planModel = list.length && list[0].id ? String(list[0].id) : "";
    if (window.moduleRegistry.registryUnavailable()) {
      $("make-unavailable").hidden = false;
      $("make-unavailable").textContent = "Could not reach the studio. Reload to try again.";
    } else if (!style.offeredShapes(reg, { host: hostFacts() }).length) {
      $("make-unavailable").hidden = false;
      $("make-unavailable").textContent = "This studio has no video style that keeps faces consistent yet. The advanced planner has every option.";
    }
    const run = readRun();
    if (run && run.jobId) {
      watch(run);
      return;
    }
    refresh();
  }
  init();
})();
