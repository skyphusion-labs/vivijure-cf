// cf#1329: a 600-scene board loads, edits and saves in the planner at a usable speed, on a phone.
// Real Chrome at 390 px with the CPU throttled 4x through the DevTools protocol, which is the usual stand-in
// for a mid-range phone. Serves public/ as files and stubs /api/*, so it needs no Worker and spends nothing.
// Run: node tests/browser/scene-editor-600.mjs (part of npm run test:browser). CHROME_PATH overrides the
// macOS default. MEASURE=1 prints the timings without judging them.
//
// Two kinds of check. Structure and behavior (rows in the DOM, the pager, edit, delete, save, a new board)
// are always judged. Wall-clock budgets are printed as WARN unless STRICT_TIMING=1: on a shared box the
// same tree measured 317 ms per key under load and 18 ms idle, so a time budget there flakes and a flaky
// gate gets ignored. The structural row count is what distinguishes this editor from the one before it.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright-core";

const ROOT = join(import.meta.dirname, "..", "..", "public");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const PAGES = { "/planner": "planner.html", "/": "planner.html" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = PAGES[path] ?? normalize(path).replace(/^\/+/, "");
  try {
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const B = `http://127.0.0.1:${server.address().port}`;

const N = 600;
// Budgets at 4x CPU throttle. A frame is 16 ms; a keystroke that takes more than 50 ms is a long task
// (RAIL), and 100 ms is where typing visibly lags. Loading a board is a one-off, so it gets a second.
const BUDGET = { renderMs: 1000, keyMs: 50, deleteMs: 1000, maxLongTasksWhileTyping: 0, idleTaskMs: 100 };
const THROTTLE = 4;

const modules = [
  { name: "silent-door", version: "1", api: "vivijure-module/2", hooks: ["motion.backend"], provides: [{ id: "s", label: "Silent door" }],
    usage: { native_audio: false, driving_audio: false }, ui: { section: "motion", order: 10, locality: "cloud", blurb: "s" } },
  { name: "keyframe", version: "1", api: "vivijure-module/2", hooks: ["keyframe"], provides: [{ id: "k", label: "k" }], ui: { section: "keyframe", order: 10 } },
  { name: "plan-enhance", version: "1", api: "vivijure-module/2", hooks: ["plan.enhance"], provides: [{ id: "p", label: "Planner" }], ui: { section: "plan", order: 1 } },
];
const registry = {
  api: "vivijure-module/2", modules,
  hooks: { "motion.backend": ["silent-door"], keyframe: ["keyframe"], "plan.enhance": ["plan-enhance"] },
  catalog: [
    { name: "keyframe", cardinality: "pick_one", order: 10, blurb: "stills" },
    { name: "motion.backend", cardinality: "pick_one", order: 20, blurb: "motion" },
    { name: "plan.enhance", cardinality: "chain", order: 1, blurb: "plan" },
  ],
  render: { quality_tiers: [{ value: "draft", label: "draft", blurb: "fast" }], default_tier: "draft" },
  host: { dispatch: false },
};
const scene = (i) => ({
  id: `shot_${i}`, act: i < 200 ? "setup" : i < 400 ? "turn" : "end",
  prompt: `Shot ${i}: the harbor at dawn, a slow push in on the pier while gulls circle.`,
  target_seconds: 6, character_slots: ["A", "B"],
  ...(i % 3 === 0 ? { dialogue: { slot: "A", text: "We leave at first light." } } : {}),
});
const board = { project: "Long", style_prefix: "", use_characters: ["A", "B"], scenes: Array.from({ length: N }, (_, i) => scene(i + 1)) };

let bad = 0;
const results = {};
const check = (name, ok, detail = "") => {
  if (process.env.MEASURE) return;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
};
const timing = (name, ok, detail = "") => {
  if (process.env.STRICT_TIMING) return check(name, ok, detail);
  if (process.env.MEASURE) return;
  console.log(`${ok ? "PASS" : "WARN"} ${name}${ok ? "" : ` ${detail}`}`);
};
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: process.env.CI ? ["--no-sandbox"] : [],
});
process.on("uncaughtException", (e) => { console.log("HARNESS", String(e).split("\n")[0]); process.exit(2); });

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ctx.addInitScript(() => {
  try { localStorage.setItem("vivijure_api_token", "test"); } catch {}
  // Long tasks are counted from the page itself, so the number is the browser's, not ours.
  window.__longTasks = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push(e.duration); })
      .observe({ type: "longtask", buffered: true });
  } catch {}
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const posted = { yaml: 0, preflight: 0 };
const J = (r, o) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
await page.route("**/api/**", (r) => {
  const { pathname } = new URL(r.request().url());
  if (pathname === "/api/modules") return J(r, registry);
  if (pathname === "/api/storyboard/models") return J(r, { models: [{ id: "m", label: "m", name: "m", default: true }], default: "m" });
  if (pathname === "/api/storyboard/plan") {
    const brief = JSON.parse(r.request().postData() || "{}").brief ?? "";
    return J(r, { ok: true, storyboard: /short/i.test(String(brief)) ? { ...board, scenes: board.scenes.slice(0, 2) } : board });
  }
  if (pathname === "/api/storyboard/preflight") { posted.preflight++; return J(r, { ok: true, issues: [] }); }
  if (pathname === "/api/storyboard/yaml") { posted.yaml++; return J(r, { ok: true, yaml: "x" }); }
  if (pathname === "/api/cast") return J(r, { cast: [] });
  if (pathname === "/api/storyboard/renders") return J(r, { renders: [] });
  return J(r, {});
});
const cdp = await ctx.newCDPSession(page);
await page.goto(`${B}/planner`);
await page.click('[data-step-id="plan"]');
await page.waitForFunction(() => document.querySelector("#planner-model")?.options.length > 0);
await page.fill("#planner-brief", "A long film.");
await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

// ---- load: plan returns 600 scenes; time until the editor shows them.
let t0 = Date.now();
await page.click("#planner-plan");
await page.waitForFunction((n) => {
  const rows = document.querySelectorAll(".planner-scene-row").length;
  return rows > 0 && (window.planState?.storyboard?.scenes?.length === n);
}, N, { timeout: 60000 });
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
results.renderMs = Date.now() - t0;
results.rowsInDom = await page.locator(".planner-scene-row").count();
results.domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);
timing(`load: 600 scenes render within ${BUDGET.renderMs} ms`, results.renderMs <= BUDGET.renderMs, `${results.renderMs} ms`);
// The timings above vary with the box; this does not. A long board keeps one window of rows in the DOM.
check("load: at most one window (50 rows) is in the DOM", results.rowsInDom <= 50, `${results.rowsInDom} rows, ${results.domNodes} nodes`);
results.pagerLabel = await page.locator("#planner-scenes-pager .planner-scenes-page-label").textContent().catch(() => null);
check("the pager says which scenes are shown", results.pagerLabel === "Scenes 1 to 50 of 600", String(results.pagerLabel));

// ---- every scene is reachable, not only the first stretch.
results.reach = await page.evaluate(async (n) => {
  if (typeof window.plannerSceneEditor?.showScene === "function") await window.plannerSceneEditor.showScene(n - 1);
  const rows = Array.from(document.querySelectorAll(".planner-scene-row"));
  return rows.some((r) => r.dataset.idx === String(n - 1));
}, N);
check("the last scene can be brought on screen", results.reach);

// ---- edit: type into a scene deep in the board; each key must stay under a long task.
await page.evaluate(async () => {
  if (typeof window.plannerSceneEditor?.showScene === "function") await window.plannerSceneEditor.showScene(449);
});
// Each key is a real input event on the real textarea, timed inside the page: the handler's own cost, and
// the time to the next frame. (Playwright's keyboard.type inserts nothing into this textarea in a mobile
// context, measured; and its round-trip would swamp the number we care about.)
await page.evaluate(() => { window.__longTasks.length = 0; });
const typed = " Rain starts.";
const keys = await page.evaluate(async (text) => {
  const ta = document.querySelector('.planner-scene-row[data-idx="449"] textarea');
  ta.focus();
  const handler = [];
  const frame = [];
  for (const ch of text) {
    const t = performance.now();
    ta.value += ch;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    handler.push(performance.now() - t);
    await new Promise((r) => requestAnimationFrame(() => r()));
    frame.push(performance.now() - t);
  }
  return { handler, frame };
}, typed);
const sorted = (a) => [...a].sort((x, y) => x - y);
const hk = sorted(keys.handler);
const fk = sorted(keys.frame);
results.keyHandlerP50 = +hk[Math.floor(hk.length / 2)].toFixed(1);
results.keyHandlerMax = +hk[hk.length - 1].toFixed(1);
results.keyFrameMax = +fk[fk.length - 1].toFixed(1);
results.longTasksWhileTyping = await page.evaluate(() => window.__longTasks.filter((d) => d > 50).length);
// Debounced work (yaml, preflight, persist, the door filter) runs after typing stops; it must not jank.
await page.evaluate(() => { window.__longTasks.length = 0; });
await page.waitForTimeout(2500);
results.longTasksAfterTyping = await page.evaluate(() => window.__longTasks.map((d) => Math.round(d)));
const edited = await page.evaluate(() => window.planState.storyboard.scenes[449].prompt);
void (() => {
  const ta = document.querySelector('.planner-scene-row[data-idx="449"] textarea');
  const a = document.activeElement;
  return { taTail: ta ? ta.value.slice(-16) : null, active: a ? a.tagName + "." + a.className + " idx=" + (a.closest?.(".planner-scene-row")?.dataset.idx ?? "-") : null };
});
check("the edit lands on scene 450 in the storyboard", edited.endsWith(typed), JSON.stringify(edited.slice(-30)));
timing(`edit: the slowest key, to the next frame, is within ${BUDGET.keyMs} ms`, results.keyFrameMax <= BUDGET.keyMs, `${results.keyFrameMax} ms (handler max ${results.keyHandlerMax}, p50 ${results.keyHandlerP50})`);
timing("edit: no long task while typing", results.longTasksWhileTyping <= BUDGET.maxLongTasksWhileTyping, `${results.longTasksWhileTyping}`);
timing(`edit: the debounced work after typing has no task over ${BUDGET.idleTaskMs} ms`, results.longTasksAfterTyping.every((d) => d <= BUDGET.idleTaskMs), JSON.stringify(results.longTasksAfterTyping));

// ---- delete: the one path that re-renders the editor.
await page.evaluate(() => { window.confirm = () => true; });
await page.evaluate(async () => {
  if (typeof window.plannerSceneEditor?.showScene === "function") await window.plannerSceneEditor.showScene(10);
});
const del = page.locator('.planner-scene-row[data-idx="10"] .planner-scene-delete').first();
await del.scrollIntoViewIfNeeded();
t0 = Date.now();
await del.click();
await page.waitForFunction((n) => window.planState.storyboard.scenes.length === n - 1, N);
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
results.deleteMs = Date.now() - t0;
const afterDel = await page.evaluate(() => ({ id10: window.planState.storyboard.scenes[10].id, label: document.querySelector('.planner-scene-row[data-idx="10"] strong')?.textContent }));
check("delete removes scene 11 and renumbers the rest", afterDel.id10 === "shot_12" && afterDel.label === "Scene 11", JSON.stringify(afterDel));
timing(`delete: re-render within ${BUDGET.deleteMs} ms`, results.deleteMs <= BUDGET.deleteMs, `${results.deleteMs} ms`);

// ---- a delete deep in the board keeps that window, and next/previous move by one window.
await page.evaluate(() => window.plannerSceneEditor.showScene(450));
await page.locator('.planner-scene-row[data-idx="451"] .planner-scene-delete').first().click();
await page.waitForFunction((n) => window.planState.storyboard.scenes.length === n - 2, N);
results.afterDeepDelete = await page.evaluate(() => ({
  first: document.querySelector(".planner-scene-row")?.dataset.idx,
  label: document.querySelector("#planner-scenes-pager .planner-scenes-page-label")?.textContent,
}));
check("a delete in scenes 451 to 500 stays on that window", results.afterDeepDelete.first === "450" && results.afterDeepDelete.label === "Scenes 451 to 500 of 598", JSON.stringify(results.afterDeepDelete));
await page.locator("#planner-scenes-pager .planner-scenes-page-next").click();
results.afterNext = await page.evaluate(() => document.querySelector(".planner-scene-row")?.dataset.idx);
await page.locator("#planner-scenes-pager-bottom .planner-scenes-page-prev").click();
results.afterPrev = await page.evaluate(() => document.querySelector(".planner-scene-row")?.dataset.idx);
check("next and previous move by one window", results.afterNext === "500" && results.afterPrev === "450", `${results.afterNext} ${results.afterPrev}`);
await page.fill("#planner-scenes-pager .planner-scenes-page-jump input", "598");
await page.locator("#planner-scenes-pager .planner-scenes-page-jump input").dispatchEvent("change");
results.afterJump = await page.evaluate(() => Array.from(document.querySelectorAll(".planner-scene-row")).map((r) => r.dataset.idx).slice(-1)[0]);
check("go to scene 598 shows the last scene", results.afterJump === "597", String(results.afterJump));

// ---- save: the edits reach what the panel persists and posts.
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
await page.waitForTimeout(1500);
const saved = await page.evaluate(() => {
  try {
    const o = JSON.parse(localStorage.getItem("skyphusion.planner.state.v1"));
    const scenes = o?.planResult?.storyboard?.scenes;
    return Array.isArray(scenes) ? { n: scenes.length, p: scenes[448]?.prompt ?? "" } : null;
  } catch { return null; }
});
results.saved = saved && { n: saved.n };
check("save: the persisted board has 598 scenes (two deleted) and the edit", !!saved && saved.n === N - 2 && saved.p.endsWith(typed), JSON.stringify(saved && { n: saved.n, tail: saved.p.slice(-20) }));
check("save: the yaml preview was refreshed with the board", posted.yaml > 0, String(posted.yaml));

// ---- a new board starts at its first scene, not at the window the last board was on.
await page.evaluate(() => window.plannerSceneEditor.showScene(500));
await page.click('[data-step-id="plan"]').catch(() => {});
await page.click("#planner-plan");
await page.waitForFunction((n) => window.planState?.storyboard?.scenes?.length === n && !!document.querySelector(".planner-scene-row"), N, { timeout: 60000 });
await page.waitForTimeout(300);
results.newBoardFirst = await page.evaluate(() => document.querySelector(".planner-scene-row")?.dataset.idx);
check("a new plan opens at scene 1", results.newBoardFirst === "0", String(results.newBoardFirst));

// ---- a board that fits in one window looks as it always did: every row, and no pager.
await page.fill("#planner-brief", "A short film.");
await page.click("#planner-plan");
await page.waitForFunction(() => window.planState?.storyboard?.scenes?.length === 2 && document.querySelectorAll(".planner-scene-row").length === 2, null, { timeout: 60000 });
results.shortBoard = await page.evaluate(() => ({
  rows: document.querySelectorAll(".planner-scene-row").length,
  pagerHidden: document.querySelector("#planner-scenes-pager").hidden && document.querySelector("#planner-scenes-pager-bottom").hidden,
}));
check("a 2-scene board shows both rows and no pager", results.shortBoard.rows === 2 && results.shortBoard.pagerHidden, JSON.stringify(results.shortBoard));
check("no page errors", errors.length === 0, errors.join("; "));

console.log("MEASURED " + JSON.stringify({ throttle: THROTTLE, ...results, posted }));
await browser.close();
server.close();
if (!process.env.MEASURE) console.log(bad ? `${bad} failed` : "all passed");
process.exit(process.env.MEASURE ? 0 : bad ? 1 : 0);
