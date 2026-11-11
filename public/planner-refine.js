// Planner UI -- refinement chat (iterative edits on the in-flight storyboard).
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- Refinement chat (v0.50.0) ----------
//
// Iterative refinement on the in-flight storyboard. Each turn POSTs
// {model, storyboard, message} to /api/storyboard/refine; the returned
// validated storyboard replaces planState.storyboard, the YAML pane and
// scene editor re-render. The chat history is display-only: not replayed
// to the model (the storyboard already reflects all accepted changes),
// just shown to the user as a log of the conversation.

let refineInflight = false;

// cf#1334 / cf#1341: a refine sends and returns the whole board. Before vivijure-core#473 the prompt capped
// the reply at PLANNER_ASK_MAX_SCENES (50), so a longer board could come back cut to 50, and the panel
// refused any shorter reply to a board over 50. Since core 1.39.0 the prompt returns every scene unless the
// user asks to remove some, and a real refine on a 60-scene board did exactly that (cf#1341: 60 to 60 when
// told not to remove, 60 to 57 when told "delete shots 10, 20 and 30"). The guard is relaxed, on the lead's
// ruling on cf#1341: a shorter reply to a board over 50 applies only when ALL THREE hold.
//   (a) The message asks to remove scenes: a removal verb whose object is a scene or shot reference.
//       "remove the rain from shot 5" is not a removal request.
//   (b) The reply is a pure removal: an in-order subsequence of the sent board, every kept scene unchanged.
//   (c) Every removed scene is named in the message, by its number or its id. This is what tells a
//       requested delete from a truncation to the first 50, which is also an in-order subsequence.
// Any other shorter reply is refused. A removal by description ("remove the night scenes") is refused too,
// and the scene editor's delete covers it.
const REFINE_GUARD_MIN_SCENES = 50;

const REFINE_REMOVE_VERB = "(?:delete|remove|drop|cut)";
const REFINE_SCENE_REF = "(?:(?:scenes?|shots?)\\s*#?\\s*\\d+|shot_\\d+|scene_\\d+)";
// A list of references: "shots 10, 20 and 30", "shot_04 and shot_09", "scene 3 & scene 7".
const REFINE_REF_LIST = REFINE_SCENE_REF + "(?:\\s*(?:,|&|\\band\\b|\\bor\\b)\\s*(?:" + REFINE_SCENE_REF + "|\\d+))*";
const REFINE_REMOVAL_RE = new RegExp(
  "\\b" + REFINE_REMOVE_VERB + "\\s+(?:the\\s+)?(?:" + REFINE_REF_LIST + ")", "gi");

/** Pure: the scenes the message asks to remove, as { numbers, ids }, or null when it asks for no removal
 *  (condition a). Only a removal verb followed directly by a scene or shot reference counts; the numbers and
 *  ids are read from those references alone, so "remove the rain from shot 5" names nothing. */
function refineRemovalRequest(message) {
  const text = String(message || "");
  const numbers = new Set();
  const ids = new Set();
  let found = false;
  REFINE_REMOVAL_RE.lastIndex = 0;
  let m;
  while ((m = REFINE_REMOVAL_RE.exec(text)) !== null) {
    found = true;
    const list = m[0].replace(new RegExp("^\\s*" + REFINE_REMOVE_VERB + "\\s+(?:the\\s+)?", "i"), "");
    for (const idm of list.matchAll(/\b((?:shot|scene)_\d+)\b/gi)) ids.add(idm[1].toLowerCase());
    for (const nm of list.replace(/\b(?:shot|scene)_\d+\b/gi, " ").matchAll(/\d+/g)) numbers.add(Number(nm[0]));
  }
  return found ? { numbers, ids } : null;
}

function refineSceneKey(scene) {
  // Stable key order, so a reply that reorders a scene's fields still compares equal.
  const sort = (v) => Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object" ? Object.keys(v).sort().reduce((o, k) => { o[k] = sort(v[k]); return o; }, {})
    : v;
  return JSON.stringify(sort(scene));
}

/** Pure: whether a shorter reply to a long board may replace it (cf#1341). Returns { ok: true, removed }
 *  with the removed scenes' 1-based positions and ids, or { ok: false, reason }. A board at or under
 *  REFINE_GUARD_MIN_SCENES, or a reply that is not shorter, is not this function's concern: ok, removed []. */
function refineRemovalAllowed(sentScenes, returnedScenes, message) {
  const sent = Array.isArray(sentScenes) ? sentScenes : [];
  const back = Array.isArray(returnedScenes) ? returnedScenes : [];
  if (!refineShrinksLongBoard(sent.length, back.length)) return { ok: true, removed: [] };
  const asked = refineRemovalRequest(message);
  if (!asked) return { ok: false, reason: "not-asked" };                               // (a)
  // (b) In-order subsequence, every kept scene unchanged. Greedy match is exact here: a scene that appears
  // in the reply must equal the next unmatched sent scene it is paired with, else the reply is not a removal.
  const removed = [];
  let j = 0;
  for (let i = 0; i < sent.length; i++) {
    if (j < back.length && refineSceneKey(sent[i]) === refineSceneKey(back[j])) { j++; continue; }
    removed.push({ position: i + 1, id: sent[i] && typeof sent[i].id === "string" ? sent[i].id : "" });
  }
  if (j !== back.length) return { ok: false, reason: "not-pure-removal" };             // (b)
  // (c) Every removed scene named: by its position (the editor's "Scene N"), by the number in its id, or by id.
  const named = (r) => asked.numbers.has(r.position)
    || (r.id && asked.ids.has(r.id.toLowerCase()))
    || (r.id && /(\d+)$/.test(r.id) && asked.numbers.has(Number(r.id.match(/(\d+)$/)[1])));
  if (!removed.every(named)) return { ok: false, reason: "removed-unnamed" };            // (c)
  return { ok: true, removed };
}

/** Pure: true when a refine reply must not replace the board, because the board it was given had more
 *  than REFINE_GUARD_MIN_SCENES scenes and the reply is shorter. */
function refineShrinksLongBoard(sentCount, returnedCount) {
  const sent = Math.floor(Number(sentCount)) || 0;
  const back = Math.floor(Number(returnedCount)) || 0;
  return sent > REFINE_GUARD_MIN_SCENES && back < sent;
}

function setRefineStatus(text, kind) {
  const el = $("#planner-refine-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "planner-status" + (kind ? " planner-" + kind : "");
}

function showRefineSection() {
  const section = $("#planner-refine");
  if (!section) return;
  if (!planState.storyboard) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  renderRefineTurns();
}

function renderRefineTurns() {
  const list = $("#planner-refine-turns");
  if (!list) return;
  list.innerHTML = "";
  for (const turn of planState.refineHistory || []) {
    const li = document.createElement("li");
    li.className = "planner-refine-turn planner-refine-turn-" + turn.role;
    const role = document.createElement("span");
    role.className = "planner-refine-role";
    role.textContent = turn.role === "user" ? "you" : "assistant";
    li.appendChild(role);
    const body = document.createElement("div");
    body.className = "planner-refine-body";
    body.textContent = turn.content || "";
    li.appendChild(body);
    list.appendChild(li);
  }
  // Scroll the list to the latest turn so a refreshed view does not bury
  // the most recent exchange.
  list.scrollTop = list.scrollHeight;
}

async function sendRefine() {
  if (refineInflight) return;
  if (!planState.storyboard) {
    setRefineStatus("plan a storyboard first", "error");
    return;
  }
  const input = $("#planner-refine-input");
  const message = (input.value || "").trim();
  if (!message) return;
  const modelEl = $("#planner-model");
  const model = modelEl ? modelEl.value : "";
  if (!model) {
    setRefineStatus("pick a planning model in the brief above", "error");
    return;
  }

  refineInflight = true;
  $("#planner-refine-send").disabled = true;
  setRefineStatus("refining...", "loading");
  // The board as sent. A refine that applies makes this the "discard all edits" baseline, so a discard
  // undoes the refine (cf#1334). A copy, so edits made while the refine is in flight do not move it.
  const sentBoard = JSON.parse(JSON.stringify(planState.storyboard));
  const sentCount = Array.isArray(sentBoard.scenes) ? sentBoard.scenes.length : 0;

  // Optimistically append the user turn so the log shows what was just
  // sent even before the response lands.
  planState.refineHistory.push({ role: "user", content: message, ts: Date.now() });
  renderRefineTurns();
  input.value = "";
  persistSoon();

  let resp;
  let data;
  try {
    resp = await fetch("/api/storyboard/refine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, storyboard: planState.storyboard, message }),
    });
    data = await resp.json();
  } catch (err) {
    setRefineStatus("network error: " + err.message, "error");
    planState.refineHistory.push({
      role: "assistant",
      content: "(network error: " + err.message + ")",
      ts: Date.now(),
    });
    renderRefineTurns();
    persistSoon();
    refineInflight = false;
    $("#planner-refine-send").disabled = false;
    return;
  }

  if (!resp.ok && data && data.error) {
    setRefineStatus("refine rejected (" + resp.status + ")", "error");
    planState.refineHistory.push({
      role: "assistant",
      content: "(error " + resp.status + ": " + data.error + ")",
      ts: Date.now(),
    });
    renderRefineTurns();
    persistSoon();
    refineInflight = false;
    $("#planner-refine-send").disabled = false;
    return;
  }

  if (data && data.ok === false) {
    const errs = Array.isArray(data.errors) ? data.errors.join(" · ") : "validation failed";
    setRefineStatus(errs, "error");
    planState.refineHistory.push({
      role: "assistant",
      content: "(could not apply: " + errs + ")",
      ts: Date.now(),
    });
    renderRefineTurns();
    persistSoon();
    refineInflight = false;
    $("#planner-refine-send").disabled = false;
    return;
  }

  const returnedCount = data && data.ok === true && data.storyboard && Array.isArray(data.storyboard.scenes)
    ? data.storyboard.scenes.length
    : 0;
  const removal = data && data.ok === true && data.storyboard
    ? refineRemovalAllowed(sentBoard.scenes, data.storyboard.scenes, message)
    : { ok: true, removed: [] };
  if (data && data.ok === true && data.storyboard && !removal.ok) {
    setRefineStatus("not applied: the board would have lost scenes", "error");
    planState.refineHistory.push({
      role: "assistant",
      content: "(not applied: the reply had " + returnedCount + " of your " + sentCount + " scenes. "
        + "On a board over " + REFINE_GUARD_MIN_SCENES + " scenes, a refine that removes scenes applies only "
        + "when your message names each scene to remove, for example \"delete shots 10, 20 and 30\", and "
        + "nothing else changes. Your board is unchanged. "
        + "To remove scenes, use delete in the scene editor.)",
      ts: Date.now(),
    });
    renderRefineTurns();
    persistSoon();
    refineInflight = false;
    $("#planner-refine-send").disabled = false;
    return;
  }

  if (data && data.ok === true && data.storyboard) {
    planState.originalStoryboard = sentBoard;
    planState.storyboard = data.storyboard;
    // #743: refine response carries no yaml field; fetch the preview like scene-edit.
    refreshYamlPreview();
    $("#planner-json").textContent = JSON.stringify(data.storyboard, null, 2);
    renderSceneEditor(data.storyboard);
    const removedNote = removal.removed.length
      ? "; removed " + removal.removed.map((r) => "Scene " + r.position + (r.id ? " (" + r.id + ")" : "")).join(", ")
        + "; discard all edits restores them"
      : "";
    planState.refineHistory.push({
      role: "assistant",
      content: "updated storyboard ("
        + (Array.isArray(data.storyboard.scenes) ? data.storyboard.scenes.length : 0)
        + " scenes" + removedNote + ")",
      ts: Date.now(),
    });
    renderRefineTurns();
    setRefineStatus("ok", "success");
    persistSoon();
    // v0.56.0: refinement rewrites the storyboard; rerun preflight so
    // the panel reflects the new shape without the user clicking.
    schedulePreflight();
  } else {
    setRefineStatus("unexpected response shape", "error");
  }

  refineInflight = false;
  $("#planner-refine-send").disabled = false;
  input.focus();
}

