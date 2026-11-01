// Film board: a long film as parts under one parent (docs/CONTRACT.md 2.22a).
// A projection of GET /api/film/:id. Phone first, because reels get reviewed from a phone.
(function () {
  "use strict";
  const POLL_MS = 15000;
  const RECENT_KEY = "skyphusion.films.recent";
  const RECENT_MAX = 20;
  const PHASE_LABELS = {
    planned: "Waiting to start",
    running: "Rendering",
    stopped: "Stopped",
    join: "Joining the parts",
    done: "Done",
    failed: "Failed",
  };
  const STATUS_LABELS = { pending: "Waiting", running: "Rendering", done: "Done", failed: "Failed" };

  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => {
    const node = Object.assign(document.createElement(tag), props || {});
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
  };

  let filmId = new URLSearchParams(location.search).get("id") || "";
  let pollTimer = null;
  let pendingAction = null;
  let pendingRetake = null;
  let pendingFind = null;
  let onlyTrouble = false;
  let latest = null;
  const partRows = new Map();
  const openParts = new Set();
  let voices = null;
  let actionNoteTimer = null;

  function readRecent() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      return Array.isArray(list) ? list.filter((r) => r && typeof r.film_id === "string") : [];
    } catch (_) {
      return [];
    }
  }

  function remember(film) {
    const next = [{ film_id: film.film_id, project: film.project || "" }]
      .concat(readRecent().filter((r) => r.film_id !== film.film_id))
      .slice(0, RECENT_MAX);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch (_) {}
  }

  function filmHref(id) {
    return "films?id=" + encodeURIComponent(id);
  }

  function renderRecent() {
    const list = $("films-recent");
    const rows = readRecent();
    list.textContent = "";
    $("films-recent-empty").hidden = rows.length > 0;
    for (const r of rows) {
      list.append(el("li", {}, el("a", { href: filmHref(r.film_id), textContent: r.project || r.film_id })));
    }
  }

  // Every film on this studio, so a phone can open one it did not start. Without the route, or on
  // any failure, the recent list above stands. The counts can lag, since this read advances nothing.
  async function loadAllFilms() {
    let films;
    try {
      const res = await fetch("/api/film");
      if (!res.ok) return;
      films = (await res.json()).films;
    } catch (_) {
      return;
    }
    if (!Array.isArray(films)) return;
    const list = $("films-all");
    list.textContent = "";
    $("films-all-wrap").hidden = false;
    $("films-recent-wrap").hidden = true;
    $("films-all-empty").hidden = films.length > 0;
    for (const f of films) {
      const stop = f.stop_reason ? ", " + f.stop_reason : "";
      list.append(el("li", {},
        el("a", { href: filmHref(f.film_id), textContent: f.project || f.film_id }),
        el("div", { className: "films-muted", textContent:
          (PHASE_LABELS[f.phase] || f.phase) + ", " + (f.shots_done ?? 0) + " of " + (f.shots_total ?? 0) + " shots" + stop })));
    }
  }

  function clock(ms) {
    if (typeof ms !== "number" || ms < 0) return "";
    const min = Math.floor(ms / 60000);
    if (min < 60) return min + " min";
    return Math.floor(min / 60) + " h " + (min % 60) + " min";
  }

  function money(n) {
    return typeof n === "number" && Number.isFinite(n) ? "$" + n.toFixed(2) : "";
  }

  function size(bytes) {
    if (typeof bytes !== "number" || bytes <= 0) return "";
    return bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + " GB" : Math.round(bytes / 1e6) + " MB";
  }

  function artifact(key) {
    return "/api/artifact/" + String(key).split("/").map(encodeURIComponent).join("/");
  }

  // No player until asked. A phone must not fetch a film to draw a list.
  function watchControl(key, label) {
    const wrap = el("div", { className: "films-watch" });
    const btn = el("button", { type: "button", className: "planner-secondary", textContent: label });
    btn.addEventListener("click", () => {
      const video = el("video", { src: artifact(key), controls: true, playsInline: true, preload: "metadata" });
      wrap.replaceChildren(video);
    });
    wrap.append(btn);
    return wrap;
  }

  function downloadLink(key, name, label) {
    return el("a", { className: "planner-secondary films-link", href: artifact(key), download: name, textContent: label });
  }

  function partName(film, part) {
    return (film.project || "film") + "-part-" + String(part.index + 1).padStart(2, "0") + ".mp4";
  }

  function buildPart(film, part) {
    const number = part.index + 1;
    const status = STATUS_LABELS[part.status] || part.status;
    const shots = (part.shots_done ?? 0) + " of " + (part.shots_total ?? 0) + " shots";
    const row = el("li", { className: "films-part films-part-" + part.status },
      el("div", { className: "films-part-head" },
        el("strong", { textContent: "Part " + number }),
        el("span", { className: "films-chip films-chip-" + part.status, textContent: status })),
      el("div", { className: "films-muted", textContent: "Master shots " + (part.shot_from + 1) + " to " + (part.shot_to + 1) }),
      el("div", { textContent: part.phase && part.status === "running" ? shots + ", " + part.phase : shots }));
    row.dataset.partIndex = String(part.index);
    if (part.status === "running" && part.shots_total > 0 && part.shots_done >= part.shots_total) {
      // status moves only on a tick, so this reads running for up to a minute. It is not stuck.
      row.append(el("div", { className: "films-muted", textContent: "All shots are done. This moves on within about a minute." }));
    }
    const inRetake = Array.isArray(part.retake_shots) ? part.retake_shots : [];
    if (inRetake.length) {
      row.append(el("div", { className: "films-warn", textContent:
        inRetake.length + (inRetake.length === 1 ? " shot" : " shots") + " waiting for or getting a new take: " + inRetake.join(", ") }));
    }
    if (part.error) row.append(el("div", { className: "films-error", textContent: part.error }));
    const actions = el("div", { className: "films-actions" });
    if (inRetake.length && (part.status === "pending" || part.status === "failed")) {
      const cancel = el("button", { type: "button", className: "planner-secondary", textContent: "Cancel the new take" });
      cancel.addEventListener("click", () => askCancel(part));
      actions.append(cancel);
    }
    if (part.status === "failed") {
      const retry = el("button", { type: "button", className: "planner-primary", textContent: "Retry failed shots" });
      retry.addEventListener("click", () => askRetry(part));
      actions.append(retry);
    }
    const shotsBox = el("div", { className: "films-shots" });
    const toggle = el("button", { type: "button", className: "planner-secondary", textContent: "Shots" });
    toggle.setAttribute("aria-expanded", "false");
    const paint = (open) => {
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "Hide shots" : "Shots";
      if (open) loadShots(part, shotsBox);
      else shotsBox.textContent = "";
    };
    toggle.addEventListener("click", () => {
      const open = !openParts.has(part.index);
      if (open) openParts.add(part.index);
      else openParts.delete(part.index);
      paint(open);
    });
    actions.append(toggle);
    if (part.output_key) actions.append(downloadLink(part.output_key, partName(film, part), "Download"));
    row.append(actions);
    if (part.output_key) row.append(watchControl(part.output_key, "Watch this part"));
    row.append(shotsBox);
    if (openParts.has(part.index)) paint(true);
    return row;
  }

  // The contract's rule. Anything else gets a 400, so do not offer it.
  function canRetake(part) {
    if (part.status === "done") return true;
    return part.status === "pending" && Array.isArray(part.retake_shots) && part.retake_shots.length > 0;
  }

  async function loadShots(part, box) {
    box.textContent = "Loading shots...";
    let shots;
    try {
      const res = await fetch("/api/film/" + encodeURIComponent(filmId) + "/parts/" + part.index + "/shots");
      if (!res.ok) throw new Error(String(res.status));
      shots = (await res.json()).shots;
    } catch (_) {
      box.textContent = "Could not load the shots of this part.";
      return;
    }
    box.textContent = "";
    if (!Array.isArray(shots) || !shots.length) {
      box.textContent = "No shots to show yet.";
      return;
    }
    const grid = el("ul", { className: "films-shot-grid" });
    for (const shot of shots) grid.append(buildShot(part, shot));
    box.append(grid);
  }

  function buildShot(part, shot) {
    const card = el("li", { className: "films-shot" });
    card.dataset.shotIndex = String(shot.index);
    if (shot.keyframe_key) {
      card.append(el("img", { src: artifact(shot.keyframe_key), loading: "lazy", alt: "Still for shot " + (shot.index + 1), className: "films-shot-still" }));
    }
    const head = el("div", { className: "films-part-head" },
      el("strong", { textContent: "Shot " + (shot.index + 1) }),
      el("span", { className: "films-chip", textContent: shot.status || "unknown" }));
    card.append(head, el("div", { className: "films-muted", textContent: shot.shot_id }));
    const planned = typeof shot.seconds === "number" ? shot.seconds + " s" : "";
    const delivered = typeof shot.delivered_seconds === "number" ? shot.delivered_seconds + " s delivered of " : "";
    const tries = typeof shot.attempts === "number" && shot.attempts > 1 ? ", " + shot.attempts + " tries" : "";
    if (planned) card.append(el("div", { className: "films-muted", textContent: delivered + planned + tries }));
    if (shot.retake_status) {
      card.append(el("div", { className: "films-warn", textContent: shot.retake_status === "running" ? "New take in progress" : "Waiting for a new take" }));
    }
    if (shot.error) card.append(el("div", { className: "films-error", textContent: shot.error }));
    if (shot.prompt) card.append(el("div", { className: "films-shot-text", textContent: shot.prompt }));
    if (shot.line) card.append(el("div", { className: "films-shot-line", textContent: "\u201C" + shot.line + "\u201D" }));
    if (shot.clip_key) card.append(watchControl(shot.clip_key, "Watch clip"));
    if (canRetake(part)) {
      const retake = el("button", { type: "button", className: "planner-secondary", textContent: "New take" });
      retake.addEventListener("click", () => askRetake(shot));
      card.append(el("div", { className: "films-actions" }, retake));
    }
    return card;
  }

  async function ensureVoices() {
    if (voices) return voices;
    try {
      const res = await fetch("/api/voices");
      voices = res.ok ? (await res.json()).voices || [] : [];
    } catch (_) {
      voices = [];
    }
    return voices;
  }

  async function askRetake(shot) {
    const dlg = $("film-retake-dialog");
    $("film-retake-title").textContent = "New take of shot " + (shot.index + 1) + "?";
    $("film-retake-prompt").value = shot.prompt || "";
    $("film-retake-line").value = shot.line || "";
    const select = $("film-retake-voice");
    select.textContent = "";
    select.append(el("option", { value: "", textContent: "keep the voice" }));
    for (const v of await ensureVoices()) select.append(el("option", { value: v.id, textContent: v.label || v.id }));
    $("film-retake-still").checked = false;
    pendingRetake = shot;
    dlg.showModal();
  }

  function retakeBody(shot) {
    const body = {};
    const prompt = $("film-retake-prompt").value.trim();
    const line = $("film-retake-line").value.trim();
    const voice = $("film-retake-voice").value;
    if (prompt && prompt !== (shot.prompt || "").trim()) body.prompt = prompt;
    if (line !== (shot.line || "").trim()) body.line = line;
    if (voice) body.voice_id = voice;
    if ($("film-retake-still").checked) body.new_still = true;
    return body;
  }

  function askCancel(part) {
    const number = part.index + 1;
    pendingAction = () => post("/parts/" + part.index + "/retake/cancel", {}, "Cancelling the new take", "Part " + number);
    $("film-retry-title").textContent = "Cancel the new take in part " + number + "?";
    $("film-retry-body").textContent = "This puts the part's film, prompts and lines back. A take that already ran stays paid for.";
    $("film-retry-note").textContent = "";
    $("film-retry-go").textContent = "Cancel the take";
    $("film-retry-dialog").showModal();
  }

  function findShot(number) {
    const parts = (latest && latest.parts) || [];
    const index = number - 1;
    const part = parts.find((p) => index >= p.shot_from && index <= p.shot_to);
    const note = $("film-action-note");
    if (!part) {
      note.textContent = "No shot " + number + " in this film.";
      return;
    }
    note.textContent = "";
    if (onlyTrouble) {
      onlyTrouble = false;
      $("film-only-trouble").checked = false;
      renderParts(latest);
    }
    const row = $("film-parts").querySelector('[data-part-index="' + part.index + '"]');
    if (!row) return;
    pendingFind = index;
    if (!openParts.has(part.index)) {
      row.querySelector(".films-actions button[aria-expanded]").click();
    } else {
      scrollToFound(row);
    }
    setTimeout(() => scrollToFound(row), 600);
  }

  function scrollToFound(row) {
    if (pendingFind === null) return;
    const card = row.querySelector('[data-shot-index="' + pendingFind + '"]');
    if (card) {
      card.scrollIntoView({ block: "center" });
      card.classList.add("films-shot-found");
      pendingFind = null;
    }
  }

  // Keep the element of an unchanged part, so a poll does not stop a playing video.
  function renderParts(film) {
    const list = $("film-parts");
    const parts = Array.isArray(film.parts) ? film.parts : [];
    const shown = onlyTrouble ? parts.filter((p) => p.status === "failed" || p.status === "running") : parts;
    let cursor = list.firstChild;
    const next = new Map();
    for (const part of shown) {
      const sig = JSON.stringify(part);
      const known = partRows.get(part.part_id);
      const row = known && known.sig === sig ? known.row : buildPart(film, part);
      next.set(part.part_id, { sig, row });
      if (row === cursor) {
        cursor = cursor.nextSibling;
      } else {
        list.insertBefore(row, cursor);
      }
    }
    while (cursor) {
      const stale = cursor;
      cursor = cursor.nextSibling;
      list.removeChild(stale);
    }
    partRows.clear();
    for (const [k, v] of next) partRows.set(k, v);
    const failed = parts.filter((p) => p.status === "failed").length;
    const running = parts.filter((p) => p.status === "running").length;
    const done = parts.filter((p) => p.status === "done").length;
    $("film-parts-count").textContent =
      parts.length + " parts: " + done + " done, " + running + " rendering, " + failed + " failed";
  }

  function allPartsDone(film) {
    const parts = film.parts || [];
    return parts.length > 0 && parts.every((p) => p.status === "done");
  }

  // stop_code is the stable key, and stop_reason is free text for people. Until the code is live the
  // ceiling is the one stop that needs its own control, and its text is fixed.
  function stopKind(film) {
    if (film.stop_code) return film.stop_code;
    return /spend ceiling/i.test(film.stop_reason || "") ? "spend_ceiling" : "";
  }

  function stopNote(film) {
    const parts = film.parts || [];
    const running = parts.filter((p) => p.status === "running").length;
    const words = [];
    const kind = stopKind(film);
    if (film.phase === "stopped" || kind === "spend_ceiling") words.push("No new parts will start.");
    else words.push("Waiting. This clears by itself.");
    if (kind === "spend_ceiling") words.push("Raise the ceiling below to carry on.");
    if (running) words.push(running + (running === 1 ? " part is" : " parts are") + " still rendering.");
    if (film.phase === "stopped" && parts.some((p) => p.status === "failed")) words.push("Retry the failed part below to carry on.");
    return words.join(" ");
  }

  function renderFilm(film) {
    latest = film;
    $("film-title").textContent = film.project || film.film_id;
    const chip = $("film-phase");
    chip.textContent = PHASE_LABELS[film.phase] || film.phase;
    chip.className = "films-chip films-chip-" + film.phase;
    const total = film.shots_total || 0;
    const done = film.shots_done || 0;
    $("film-shots").textContent = done + " of " + total + " shots";
    const bar = $("film-bar");
    bar.max = total || 1;
    bar.value = done;
    const elapsed = clock(film.elapsed_ms);
    $("film-elapsed").textContent = elapsed ? "Running for " + elapsed : "";
    // cost_actual is always null: no meter attributes spend to one film. Null is not zero.
    const est = money(film.cost_est);
    $("film-cost").textContent = (est ? "Estimate " + est + ". " : "No estimate. ") + "Actual spend is not known per film.";

    // A running film can also carry a stop_reason: a held part, which clears by itself.
    const stop = $("film-stop");
    const stopped = film.phase === "stopped";
    stop.hidden = !stopped && !film.stop_reason;
    if (!stop.hidden) {
      $("film-stop-reason").textContent = film.stop_reason || "No reason given.";
      $("film-stop-note").textContent = stopNote(film);
    }
    // Stopped with nothing failed: a hold or a ceiling. A failed film with every part done: a failed
    // join, and nothing paid for is lost. The server refuses if there is nothing to resume.
    const failedParts = (film.parts || []).some((p) => p.status === "failed");
    const rejoin = film.phase === "failed" && allPartsDone(film);
    const resume = $("film-resume");
    const kind = stopKind(film);
    resume.hidden = !rejoin && !(stopped && !failedParts && kind !== "spend_ceiling" && kind !== "gate_held");
    resume.textContent = rejoin ? "Join the parts again" : "Resume the film";
    resume.onclick = () => askResume(rejoin);

    const ceiling = $("film-ceiling");
    const canRaise = typeof film.spend_ceiling_usd === "number" && film.phase !== "done" && film.phase !== "failed";
    ceiling.hidden = !canRaise;
    if (canRaise && document.activeElement !== $("film-ceiling-input") && !$("film-ceiling-input").value) {
      $("film-ceiling-input").min = String(film.spend_ceiling_usd);
    }
    $("film-spend").textContent = typeof film.spend_ceiling_usd === "number"
      ? "Committed " + (money(film.spend_committed_est) || "$0.00") + " of a " + money(film.spend_ceiling_usd) + " ceiling."
      : "";
    $("film-basis").textContent = film.spend_ceiling_basis || "";
    const degraded = film.degraded;
    $("film-degraded").hidden = !degraded;
    $("film-degraded").textContent = degraded
      ? "Shipped with a limit: " + (typeof degraded === "string" ? degraded : JSON.stringify(degraded))
      : "";
    $("film-error").hidden = !film.error;
    $("film-error").textContent = film.error || "";

    // No tick for 3 minutes looks exactly like a slow film, so say it. Resume only restores the marker
    // on a film that can act, so it asks nothing and costs nothing.
    const stale = !!(film.cron && film.cron.stale) && stillMoving(film);
    $("film-cron").hidden = !stale;
    const retaking = (film.parts || []).some((p) => Array.isArray(p.retake_shots) && p.retake_shots.length);
    $("film-retake-note").hidden = !(retaking && film.output_key);
    const output = $("film-output");
    const sig = [film.output_key, film.sidecar_key, film.bytes, film.duration_seconds].join("|");
    if (output.dataset.sig !== sig) {
      output.dataset.sig = sig;
      output.textContent = "";
      output.hidden = !film.output_key;
      if (film.output_key) {
        const facts = [clock((film.duration_seconds || 0) * 1000), size(film.bytes)].filter(Boolean).join(", ");
        const actions = el("div", { className: "films-actions" },
          downloadLink(film.output_key, (film.project || "film") + ".mp4", "Download the film"),
          film.sidecar_key ? downloadLink(film.sidecar_key, (film.project || "film") + ".srt", "Captions") : null);
        output.append(
          el("h2", { textContent: "The film" }),
          facts ? el("div", { className: "films-muted", textContent: facts }) : null,
          actions,
          watchControl(film.output_key, "Watch the film"));
      }
    }
    renderParts(film);
  }

  function stillMoving(film) {
    if ((film.parts || []).some((p) => p.status === "running" || (Array.isArray(p.retake_shots) && p.retake_shots.length))) return true;
    return film.phase === "planned" || film.phase === "running" || film.phase === "join";
  }

  function schedule(film) {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (document.hidden || !stillMoving(film)) return;
    const policy = window.pollSchedule;
    const delay = policy ? policy.nextPollDelayMs({ baseMs: POLL_MS }) : POLL_MS;
    pollTimer = setTimeout(load, delay);
  }

  async function load() {
    const note = $("film-load-note");
    let res;
    try {
      res = await fetch("/api/film/" + encodeURIComponent(filmId));
    } catch (_) {
      note.textContent = "Could not reach the studio. Trying again.";
      pollTimer = setTimeout(load, POLL_MS);
      return;
    }
    if (res.status === 404) {
      note.textContent = "No film with that id on this studio.";
      $("film-detail").hidden = true;
      return;
    }
    if (!res.ok) {
      note.textContent = "The studio answered " + res.status + ". Trying again.";
      pollTimer = setTimeout(load, POLL_MS);
      return;
    }
    const film = await res.json();
    note.textContent = "";
    $("film-detail").hidden = false;
    remember(film);
    renderFilm(film);
    schedule(film);
  }

  function askRetry(part) {
    const number = part.index + 1;
    pendingAction = () => retry(part.index);
    $("film-retry-title").textContent = "Retry part " + number + "?";
    $("film-retry-body").textContent = "This re-runs the shots that failed and keeps what already finished. It can cost money, and the studio cannot give a price.";
    // The studio does not know if this part was bought. Retrying blind can buy it twice.
    $("film-retry-note").textContent = String(part.error || "").includes("submit outcome unknown")
      ? "The studio does not know if this part started. Check its project first, because a retry can buy it twice."
      : "";
    $("film-retry-go").textContent = "Retry";
    $("film-retry-dialog").showModal();
  }

  function askResume(rejoin) {
    pendingAction = () => post("/resume", {}, rejoin ? "Joining again" : "Resuming", "The film");
    $("film-retry-title").textContent = rejoin ? "Join the parts again?" : "Resume this film?";
    $("film-retry-body").textContent = rejoin
      ? "Every part is kept. This only runs the join again."
      : "This starts the remaining parts, which cost money.";
    $("film-retry-note").textContent = "";
    $("film-retry-go").textContent = rejoin ? "Join again" : "Resume";
    $("film-retry-dialog").showModal();
  }

  // Every action reads the same way: the server's refusal is shown as it came.
  async function post(path, body, doing, subject) {
    const note = $("film-load-note");
    note.textContent = doing + "...";
    let res;
    try {
      res = await fetch("/api/film/" + encodeURIComponent(filmId) + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (_) {
      note.textContent = "Could not reach the studio. " + subject + " did not change.";
      return;
    }
    if (!res.ok) {
      const out = await res.json().catch(() => ({}));
      note.textContent = subject + " did not change: " + (out.error || "the studio answered " + res.status);
      return;
    }
    note.textContent = "";
    await load();
    // These routes write state, and the next cron tick acts on it.
    const done = $("film-action-note");
    done.textContent = doing + ": saved. It takes effect within about a minute.";
    clearTimeout(actionNoteTimer);
    actionNoteTimer = setTimeout(() => { done.textContent = ""; }, 90000);
  }

  function retry(index) {
    const number = index + 1;
    return post("/parts/" + index + "/retry", { shots: "failed" }, "Retrying part " + number, "Part " + number);
  }

  function init() {
    renderRecent();
    $("film-retake-dialog").addEventListener("close", () => {
      const shot = pendingRetake;
      pendingRetake = null;
      if ($("film-retake-dialog").returnValue === "go" && shot) {
        post("/shots/" + encodeURIComponent(shot.shot_id) + "/retake", retakeBody(shot), "New take of shot " + (shot.index + 1), "Shot " + (shot.index + 1));
      }
    });
    $("film-wake").addEventListener("click", () => post("/resume", {}, "Waking the film", "The film"));
    $("film-find").addEventListener("submit", (event) => {
      event.preventDefault();
      const number = Number($("film-find-number").value);
      if (number > 0) findShot(number);
    });
    $("film-ceiling").addEventListener("submit", (event) => {
      event.preventDefault();
      const value = Number($("film-ceiling-input").value);
      if (!(value > 0)) return;
      $("film-ceiling-input").value = "";
      post("/ceiling", { spend_ceiling_usd: value }, "Raising the ceiling", "The ceiling");
    });
    $("films-open").addEventListener("submit", (event) => {
      event.preventDefault();
      const id = $("films-open-id").value.trim();
      if (id) location.href = filmHref(id);
    });
    $("film-retry-dialog").addEventListener("close", () => {
      const action = pendingAction;
      pendingAction = null;
      if ($("film-retry-dialog").returnValue === "go" && action) action();
    });
    $("film-only-trouble").addEventListener("change", (event) => {
      onlyTrouble = event.target.checked;
      if (latest) renderParts(latest);
    });
    document.addEventListener("visibilitychange", () => {
      if (!filmId) return;
      if (document.hidden) {
        clearTimeout(pollTimer);
        pollTimer = null;
      } else if (latest && stillMoving(latest)) {
        load();
      }
    });
    if (filmId) {
      $("films-home").hidden = true;
      load();
    } else {
      loadAllFilms();
    }
  }
  init();
})();
