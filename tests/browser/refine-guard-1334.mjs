// cf#1334: a refine reply that would shorten a board of more than 50 scenes is not applied, and a refine
// that is applied becomes the "discard all edits" baseline. Real Chrome, public/ served as files, /api/*
// stubbed, so it needs no Worker and spends nothing. Run: node tests/browser/refine-guard-1334.mjs.
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

const registry = {
  api: "vivijure-module/2",
  modules: [
    { name: "silent-door", version: "1", api: "vivijure-module/2", hooks: ["motion.backend"], provides: [{ id: "s", label: "Silent door" }],
      usage: { native_audio: false, driving_audio: false }, ui: { section: "motion", order: 10, locality: "cloud", blurb: "s" } },
    { name: "plan-enhance", version: "1", api: "vivijure-module/2", hooks: ["plan.enhance"], provides: [{ id: "p", label: "Planner" }], ui: { section: "plan", order: 1 } },
  ],
  hooks: { "motion.backend": ["silent-door"], "plan.enhance": ["plan-enhance"] },
  catalog: [
    { name: "motion.backend", cardinality: "pick_one", order: 20, blurb: "motion" },
    { name: "plan.enhance", cardinality: "chain", order: 1, blurb: "plan" },
  ],
  render: { quality_tiers: [{ value: "draft", label: "draft", blurb: "fast" }], default_tier: "draft" },
  host: { dispatch: false },
};
const scene = (i, prompt) => ({ id: `shot_${i}`, act: "setup", prompt: prompt ?? `Shot ${i} on the pier.`, target_seconds: 6 });
const boardOf = (n) => ({ project: "Long", style_prefix: "", use_characters: [], scenes: Array.from({ length: n }, (_, i) => scene(i + 1)) });

let bad = 0;
const check = (name, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
};
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: process.env.CI ? ["--no-sandbox"] : [],
});
process.on("uncaughtException", (e) => { console.log("HARNESS", String(e).split("\n")[0]); process.exit(2); });

async function session(planned) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => { try { localStorage.setItem("vivijure_api_token", "test"); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const J = (r, o) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  await page.route("**/api/**", (r) => {
    const { pathname } = new URL(r.request().url());
    if (pathname === "/api/modules") return J(r, registry);
    if (pathname === "/api/storyboard/models") return J(r, { models: [{ id: "m", label: "m", name: "m", default: true }], default: "m" });
    if (pathname === "/api/storyboard/plan") return J(r, { ok: true, storyboard: planned });
    if (pathname === "/api/storyboard/refine") {
      const { storyboard, message } = JSON.parse(r.request().postData());
      const scenes = storyboard.scenes;
      // "shrink" answers the way the capped prompt asks: the first 50 scenes (or one fewer on a short board).
      if (message === "shrink") return J(r, { ok: true, storyboard: { ...storyboard, scenes: scenes.slice(0, Math.min(50, scenes.length - 1)) } });
      // "edit" rewrites scene 1 and keeps every scene; "grow" adds one.
      if (message === "edit") return J(r, { ok: true, storyboard: { ...storyboard, scenes: [scene(1, "Rewritten by refine."), ...scenes.slice(1)] } });
      if (message === "grow") return J(r, { ok: true, storyboard: { ...storyboard, scenes: [...scenes, scene(scenes.length + 1)] } });
      return J(r, { ok: false, errors: ["unknown"] });
    }
    if (pathname === "/api/storyboard/yaml") return J(r, { ok: true, yaml: "x" });
    if (pathname === "/api/storyboard/preflight") return J(r, { ok: true, issues: [] });
    if (pathname === "/api/cast") return J(r, { cast: [] });
    if (pathname === "/api/storyboard/renders") return J(r, { renders: [] });
    return J(r, {});
  });
  await page.goto(`${B}/planner`);
  await page.click('[data-step-id="plan"]');
  await page.waitForFunction(() => document.querySelector("#planner-model")?.options.length > 0);
  await page.fill("#planner-brief", "A film.");
  await page.click("#planner-plan");
  await page.waitForFunction((n) => window.planState?.storyboard?.scenes?.length === n, planned.scenes.length);
  await page.evaluate(() => { window.confirm = () => true; });
  return { ctx, page, errors };
}
const refine = async (page, message) => {
  const before = await page.evaluate(() => window.planState.refineHistory.length);
  await page.evaluate((m) => { document.querySelector("#planner-refine-input").value = m; return sendRefine(); }, message);
  await page.waitForFunction((n) => window.planState.refineHistory.length >= n + 2, before);
  return page.evaluate(() => ({
    n: window.planState.storyboard.scenes.length,
    first: window.planState.storyboard.scenes[0].prompt,
    last: window.planState.refineHistory[window.planState.refineHistory.length - 1].content,
    status: document.querySelector("#planner-refine-status")?.textContent,
  }));
};

// ---- a board of 60: a shortened reply is refused and the board is kept.
{
  const { ctx, page, errors } = await session(boardOf(60));
  const r = await refine(page, "shrink");
  check("60 scenes: a reply of 50 is not applied", r.n === 60, String(r.n));
  check("the chat says why and points to delete", /not applied/.test(r.last) && /50 of your 60/.test(r.last) && /delete in the scene editor/.test(r.last), r.last);
  check("the status says it was not applied", /not applied/.test(r.status || ""), String(r.status));
  check("scene 60 is still in the board", await page.evaluate(() => window.planState.storyboard.scenes[59]?.id === "shot_60"));

  // ---- a reply that keeps every scene is applied, and discard returns to the board before it: the
  // filmmaker's own edit to scene 2 stays, and only the refine's rewrite of scene 1 is undone.
  await page.locator('.planner-scene-row[data-idx="1"] textarea').first().fill("Edited by hand.");
  const e = await refine(page, "edit");
  check("60 scenes: a reply that keeps them all is applied", e.n === 60 && e.first === "Rewritten by refine.", JSON.stringify(e));
  check("an applied refine shows as an edit", await page.evaluate(() => !document.querySelector("#planner-scenes-dirty-badge").hidden));
  await page.click("#planner-scenes-discard");
  const d = await page.evaluate(() => ({
    n: window.planState.storyboard.scenes.length,
    first: window.planState.storyboard.scenes[0].prompt,
    second: window.planState.storyboard.scenes[1].prompt,
  }));
  check("discard all edits returns to the board before the refine", d.n === 60 && d.first === "Shot 1 on the pier." && d.second === "Edited by hand.", JSON.stringify(d));

  const g = await refine(page, "grow");
  check("60 scenes: a reply that adds a scene is applied", g.n === 61, String(g.n));
  check("no page errors", errors.length === 0, errors.join("; "));
  await ctx.close();
}

// ---- a short board: a refine that removes a scene is applied as before.
{
  const { ctx, page, errors } = await session(boardOf(3));
  const r = await refine(page, "shrink");
  check("3 scenes: a reply of 2 is applied, as before", r.n === 2, String(r.n));
  check("short board: no page errors", errors.length === 0, errors.join("; "));
  await ctx.close();
}

// ---- exactly 50 is not a long board: the guard starts above it.
{
  const { ctx, page } = await session(boardOf(50));
  const r = await refine(page, "shrink");
  check("50 scenes: a reply of 49 is applied", r.n === 49, String(r.n));
  await ctx.close();
}

await browser.close();
server.close();
console.log(bad ? `${bad} failed` : "all passed");
process.exit(bad ? 1 : 0);
