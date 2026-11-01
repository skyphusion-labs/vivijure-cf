// Start a long film (POST /api/film, docs/CONTRACT.md 2.22a). For the team running reels.
// Caps and doors come from GET /api/modules. Nothing spends until the confirm, and create only writes.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const DEFAULT_PART_SIZE = 30;
  if (!new URLSearchParams(location.search).has("new")) return;

  let render = {};
  let doors = [];
  let cast = [];
  let projects = [];
  // One key for this form, so a double tap or a retry cannot start two films.
  const idempotencyKey = "form-" + crypto.randomUUID();

  function board() {
    const text = $("new-board").value.trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && Array.isArray(parsed.scenes) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function seconds(scene) {
    return Number(scene.target_seconds || scene.seconds) || 0;
  }

  function hasSpokenLines(b) {
    return b.scenes.some((s) => s && s.dialogue && String(s.dialogue.text || "").trim());
  }

  function canSpeak(mod) {
    const u = mod.usage || {};
    return u.native_audio === true || u.driving_audio === true;
  }

  function doorLabel(mod) {
    return (mod.provides && mod.provides[0] && mod.provides[0].label) || mod.name;
  }

  function fill(select, rows, keep) {
    const before = keep ? select.value : "";
    select.textContent = "";
    for (const [value, label] of rows) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      select.append(opt);
    }
    if (before && rows.some((r) => r[0] === before)) select.value = before;
  }

  function renderDoors(b) {
    const list = b && hasSpokenLines(b) ? doors.filter(canSpeak) : doors;
    fill($("new-door"), list.map((m) => [m.name, doorLabel(m)]), true);
  }

  function slotsOf(b) {
    const slots = new Set(Array.isArray(b.use_characters) ? b.use_characters : []);
    for (const s of b.scenes) for (const slot of s.character_slots || []) slots.add(slot);
    return Array.from(slots).sort();
  }

  function renderSlots(b) {
    const wrap = $("new-cast");
    const slots = b ? slotsOf(b) : [];
    const chosen = {};
    for (const sel of wrap.querySelectorAll("select")) chosen[sel.dataset.slot] = sel.value;
    wrap.textContent = "";
    for (const slot of slots) {
      const label = document.createElement("label");
      label.className = "planner-field";
      const span = document.createElement("span");
      const named = b.characters && b.characters[slot] && b.characters[slot].name;
      span.textContent = "cast for slot " + slot + (named ? " (" + named + ")" : "");
      const sel = document.createElement("select");
      sel.dataset.slot = slot;
      fill(sel, [["", "choose"]].concat(cast.map((c) => [String(c.id), c.name])), false);
      const guess = cast.find((c) => c.name === named);
      sel.value = chosen[slot] || (guess ? String(guess.id) : "");
      sel.addEventListener("change", refresh);
      label.append(span, sel);
      wrap.append(label);
    }
  }

  function partCount(total) {
    const breaks = $("new-breaks").value.trim();
    if (breaks) return { count: breaks.split(",").length + 1, largest: largestFromBreaks(breaks, total) };
    const size = Number($("new-part-size").value) || 0;
    return size > 0 ? { count: Math.ceil(total / size), largest: Math.min(size, total) } : { count: 0, largest: 0 };
  }

  function largestFromBreaks(text, total) {
    const ends = text.split(",").map(Number).concat(total);
    let from = 0;
    let largest = 0;
    for (const end of ends) {
      largest = Math.max(largest, end - from);
      from = end;
    }
    return largest;
  }

  // The door's rate is clip money only, so this is a starting figure a person confirms.
  function suggestPerShot(b) {
    const mod = doors.find((m) => m.name === $("new-door").value);
    const rate = mod && mod.ui && mod.ui.cost_usd_per_second;
    if (!Array.isArray(rate) || !b.scenes.length) return null;
    const total = b.scenes.reduce((sum, s) => sum + seconds(s), 0);
    return Number(((rate[1] * total) / b.scenes.length).toFixed(2));
  }

  function problems(b) {
    const out = [];
    if (!/^[A-Za-z0-9_-]{1,48}$/.test($("new-project").value.trim())) out.push("Name: 1 to 48 letters, digits, _ or -.");
    if (!b) {
      out.push("Master board: paste JSON with a scenes list, or pick a project.");
      return out;
    }
    const ids = b.scenes.map((s) => s.shot_id || s.id);
    if (ids.some((i) => !i) || new Set(ids).size !== ids.length) out.push("Every shot needs its own id.");
    if (b.scenes.some((s) => seconds(s) <= 0)) out.push("Every shot needs seconds above 0.");
    const { count, largest } = partCount(b.scenes.length);
    if (!count) out.push("Set a part size or breaks.");
    if (render.max_parts && count > render.max_parts) out.push("That makes " + count + " parts. The limit is " + render.max_parts + ".");
    if (render.max_scenes_per_part && largest > render.max_scenes_per_part) out.push("A part has " + largest + " shots. The limit is " + render.max_scenes_per_part + ".");
    for (const sel of $("new-cast").querySelectorAll("select")) {
      if (!sel.value) out.push("Choose a cast member for slot " + sel.dataset.slot + ".");
    }
    if (!$("new-door").value) out.push(hasSpokenLines(b) ? "This board has spoken lines, and no talking door is installed." : "No motion door is installed.");
    if (!(Number($("new-per-shot").value) > 0)) out.push("Enter your estimate per shot. The ceiling works from it.");
    if (!(Number($("new-ceiling").value) > 0)) out.push("Enter a spend ceiling.");
    return out;
  }

  function refresh() {
    const b = board();
    renderDoors(b);
    if (document.activeElement !== $("new-door")) renderSlotsIfChanged(b);
    const facts = $("new-facts");
    if (b) {
      const total = b.scenes.reduce((sum, s) => sum + seconds(s), 0);
      const { count } = partCount(b.scenes.length);
      facts.textContent = b.scenes.length + " shots, about " + (total < 90 ? Math.round(total) + " seconds, " : Math.round(total / 60) + " minutes, ") + count + " parts.";
      const hint = suggestPerShot(b);
      $("new-per-shot-hint").textContent = hint === null
        ? "This door states no rate, so the studio cannot suggest a figure."
        : "This door's top rate suggests about $" + hint.toFixed(2) + " a shot, clips only.";
    } else {
      facts.textContent = "";
      $("new-per-shot-hint").textContent = "";
    }
    const list = problems(b);
    $("new-problems").textContent = list.join(" ");
    $("new-start").disabled = list.length > 0;
  }

  let lastSlots = "";
  function renderSlotsIfChanged(b) {
    const sig = b ? slotsOf(b).join() + cast.length : "";
    if (sig !== lastSlots) {
      lastSlots = sig;
      renderSlots(b);
    }
  }

  function buildRequest(b) {
    const character_refs = {};
    const cast_loras = {};
    for (const sel of $("new-cast").querySelectorAll("select")) {
      const c = cast.find((row) => String(row.id) === sel.value);
      if (!c) continue;
      const keys = [c.portrait_key].concat(c.ref_keys || [], c.source_keys || [])
        .map((k) => (typeof k === "string" ? k : k && k.key))
        .filter(Boolean);
      character_refs[sel.dataset.slot] = { name: c.name, prompt: c.bible || "", trainingImages: Array.from(new Set(keys)).map((key) => ({ key })) };
      cast_loras[sel.dataset.slot] = c.id;
    }
    const [width, height] = $("new-frame").value.split("x").map(Number);
    const req = {
      project: $("new-project").value.trim(),
      idempotency_key: idempotencyKey,
      storyboard: b,
      character_refs,
      shared: {
        motion_backend: $("new-door").value,
        style: $("new-look").value,
        delivery_width: width,
        delivery_height: height,
        cast_loras,
        qualityTier: $("new-tier").value,
      },
      spend_ceiling_usd: Number($("new-ceiling").value),
      cost_usd_per_shot_est: Number($("new-per-shot").value),
      pause_after_first_part: $("new-pause").checked,
    };
    const breaks = $("new-breaks").value.trim();
    if (breaks) req.breaks = breaks.split(",").map(Number);
    else req.part_size = Number($("new-part-size").value);
    const overrides = $("new-overrides").value.trim();
    if (overrides) req.part_overrides = JSON.parse(overrides);
    return req;
  }

  function askStart() {
    const b = board();
    let overridesOk = true;
    try {
      buildRequest(b);
    } catch (_) {
      overridesOk = false;
    }
    if (!overridesOk) {
      $("new-problems").textContent = "Per-part changes must be a JSON list.";
      return;
    }
    const { count } = partCount(b.scenes.length);
    const est = Number($("new-per-shot").value) * b.scenes.length;
    $("new-confirm-what").textContent = b.scenes.length + " shots in " + count + " parts, on " + $("new-door").selectedOptions[0].textContent + ".";
    $("new-confirm-cost").textContent = "Your estimate: about $" + est.toFixed(2) + ". Ceiling: $" + Number($("new-ceiling").value).toFixed(2) + ". This is not a measured price.";
    $("new-confirm-hold").textContent = $("new-pause").checked
      ? "It stops after the first part, so you can watch it before the rest run."
      : "It does not stop after the first part. Every part runs.";
    $("new-confirm").showModal();
  }

  async function start() {
    const note = $("new-note");
    note.textContent = "Starting...";
    let res;
    try {
      res = await fetch("/api/film", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildRequest(board())),
      });
    } catch (_) {
      note.textContent = "Could not reach the studio. Nothing started. It is safe to press Start again.";
      return;
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.film_id) {
      note.textContent = "Not started: " + (out.error || "the studio answered " + res.status);
      return;
    }
    // Create only writes. The film page's first read starts it.
    location.href = "films?id=" + encodeURIComponent(out.film_id);
  }

  async function init() {
    $("films-home").hidden = true;
    $("films-new").hidden = false;
    for (const id of ["new-project", "new-board", "new-part-size", "new-breaks", "new-per-shot", "new-ceiling"]) {
      $(id).addEventListener("input", refresh);
    }
    $("new-door").addEventListener("change", refresh);
    $("new-start").addEventListener("click", askStart);
    $("new-confirm").addEventListener("close", () => {
      if ($("new-confirm").returnValue === "go") start();
    });
    $("new-from-project").addEventListener("change", () => {
      const p = projects.find((row) => String(row.id) === $("new-from-project").value);
      if (p && p.last_storyboard) {
        $("new-board").value = JSON.stringify(p.last_storyboard);
        if (!$("new-project").value) $("new-project").value = String(p.name || "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48);
      }
      refresh();
    });
    const reg = await window.moduleRegistry.load();
    render = reg.render || {};
    const names = (reg.hooks && reg.hooks["motion.backend"]) || [];
    doors = names.map((n) => (reg.modules || []).find((m) => m.name === n)).filter(Boolean);
    fill($("new-tier"), (render.quality_tiers || []).map((t) => [t.value, t.label]), false);
    if (render.default_tier) $("new-tier").value = render.default_tier;
    const size = Math.min(DEFAULT_PART_SIZE, render.max_scenes_per_part || DEFAULT_PART_SIZE);
    $("new-part-size").value = String(size);
    if (render.max_scenes_per_part) $("new-part-size").max = String(render.max_scenes_per_part);
    const [castRes, projectRes] = await Promise.all([
      fetch("/api/cast").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("/api/storyboard/projects").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    cast = Array.isArray(castRes.cast) ? castRes.cast : [];
    projects = (Array.isArray(projectRes.projects) ? projectRes.projects : []).filter((p) => p.last_storyboard);
    fill($("new-from-project"), [["", "paste below instead"]].concat(projects.map((p) => [String(p.id), p.name])), false);
    refresh();
  }
  init();
})();
