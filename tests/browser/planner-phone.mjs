// Real pages in real Chrome at phone width. The unit tests eval one script against a stub window, so
// they could not see that window.planState was undefined in a browser. This can.
// Serves public/ as files and stubs /api/*, so it needs no Worker and spends nothing.
// Run: npm run test:browser. CHROME_PATH overrides the macOS default.
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

const door = (name, label, usage, ui = {}) => ({
  name, version: "1", api: "vivijure-module/2", hooks: ["motion.backend"], provides: [{ id: name, label }], usage,
  ui: { section: "motion", order: 10, locality: "cloud", cost: "Pay per render", blurb: label, ...ui },
});
const stills = (name, order) => ({
  name, version: "1", api: "vivijure-module/2", hooks: ["keyframe"], provides: [{ id: name, label: name }],
  config_schema: { style: { type: "enum", values: ["photoreal", "anime"], default: "photoreal", label: "still look" } },
  ui: { section: "keyframe", order },
});
const modules = [
  door("silent-door", "Silent door", { native_audio: false, driving_audio: false }),
  door("talk-priced", "Priced talking door", { native_audio: true, driving_audio: false }, { cost_usd_per_second: [0.04, 0.07] }),
  door("talk-unpriced", "Unpriced talking door", { native_audio: true, driving_audio: false }),
  stills("keyframe", 10),
  stills("cloud-keyframe", 5),
  { name: "plan-enhance", version: "1", api: "vivijure-module/2", hooks: ["plan.enhance"], provides: [{ id: "p", label: "Planner" }], ui: { section: "plan", order: 1 } },
];
const registry = {
  api: "vivijure-module/2", modules,
  hooks: {
    "motion.backend": ["silent-door", "talk-priced", "talk-unpriced"],
    keyframe: ["cloud-keyframe", "keyframe"],
    "plan.enhance": ["plan-enhance"],
  },
  catalog: [
    { name: "keyframe", cardinality: "pick_one", order: 10, blurb: "stills" },
    { name: "motion.backend", cardinality: "pick_one", order: 20, blurb: "motion" },
    { name: "plan.enhance", cardinality: "chain", order: 1, blurb: "plan" },
  ],
  render: { quality_tiers: [{ value: "draft", label: "draft", blurb: "fast" }], default_tier: "draft" },
  host: { dispatch: false },
};
const scene = (i, line) => ({ id: `shot_${i}`, act: "setup", prompt: `Shot ${i} on the pier.`, target_seconds: 6, character_slots: ["A"], ...(line ? { dialogue: { slot: "A", text: "We leave at first light." } } : {}) });
const board = (spoken) => ({ project: "Test", style_prefix: "", use_characters: ["A"], scenes: [scene(1, spoken), scene(2, false)] });

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

const TRAINED = [{ id: "c1", slug: "mara", name: "Mara", portrait_key: "p.png", ref_keys: [], source_keys: [], lora_status: "ready", lora_key: "loras/m.safetensors" }];
async function session({ width, spoken, cast = TRAINED, poll = { status: "IN_PROGRESS", statusRaw: "running", output: { phase: "keyframes", scene_total: 2, shots_done: 1 } } }) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 500, hasTouch: width < 500 });
  await ctx.addInitScript(() => { try { localStorage.setItem("vivijure_api_token", "test"); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  const submits = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const J = (r, o, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
  await page.route("**/api/**", (r) => {
    const { pathname } = new URL(r.request().url());
    if (pathname === "/api/modules") return J(r, registry);
    if (pathname === "/api/storyboard/models") return J(r, { models: [{ id: "m", label: "m", name: "m", default: true }], default: "m" });
    if (pathname === "/api/storyboard/plan") return J(r, { ok: true, storyboard: board(spoken) });
    if (pathname === "/api/storyboard/bundle") return J(r, { ok: true, bundleKey: "bundles/t.tar.gz", sizeBytes: 1, fileCount: 1 });
    if (pathname === "/api/storyboard/preflight") return J(r, { ok: true, issues: [] });
    if (pathname === "/api/storyboard/yaml") return J(r, { yaml: "x" });
    if (pathname === "/api/cast") return J(r, { cast });
    if (pathname === "/api/storyboard/renders") return J(r, { renders: [] });
    if (pathname === "/api/storyboard/render") {
      submits.push(JSON.parse(r.request().postData()));
      return J(r, { jobId: "film-1", id: "film-1", job_id: "film-1", status: "IN_QUEUE" });
    }
    if (pathname.startsWith("/api/storyboard/render/")) return J(r, typeof poll === "function" ? poll() : poll);
    return J(r, {});
  });
  await page.goto(`${B}/planner`);
  await page.click('[data-step-id="plan"]');
  await page.waitForFunction(() => document.querySelector("#planner-model")?.options.length > 0);
  await page.fill("#planner-brief", "A short film.");
  await page.click("#planner-plan");
  await page.waitForSelector(".planner-scene-row");
  await page.evaluate(() => { planState.castBindings = { A: "c1" }; });
  return { ctx, page, errors, submits };
}
process.on("uncaughtException", (e) => { console.log("HARNESS", String(e).split("\n")[0]); process.exit(2); });
const hit = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  const r = e.getBoundingClientRect();
  if (!r.width) return false;
  const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return !!t && (t === e || e.contains(t));
}, sel);
const doors = (page) => page.$$eval("#planner-motion-backend option", (o) => o.map((e) => e.value).filter(Boolean));
const LABELS = { "talk-priced": "Priced talking door", "talk-unpriced": "Unpriced talking door" };
const pickDoor = (page, name) => page.locator(".planner-backend-selector label, .planner-backend-selector [role=radio]").filter({ hasText: LABELS[name] }).first().click();
const gotoRender = async (page) => { await page.click('[data-step-id="render"]'); await page.waitForSelector("#planner-render-btn"); };

// ---- phone: the dock does not trap.
{
  const { ctx, page, errors, submits } = await session({ width: 390, spoken: true });
  check("phone: dock stays shut after a plan", !(await page.evaluate(() => document.body.classList.contains("sw-open"))));
  check("phone: the render step is reachable", await hit(page, '[data-step-id="render"]'));
  check("phone: the dock tab is reachable", await hit(page, "#sw-tab"));
  await page.tap("#sw-tab");
  await page.waitForTimeout(350);
  check("phone: tab opens the dock", await page.evaluate(() => document.body.classList.contains("sw-open")));
  check("phone: close button is reachable", await hit(page, "#sw-dock-close"));
  await page.tap("#sw-dock-close");
  await page.waitForTimeout(350);
  check("phone: close button closes it", !(await page.evaluate(() => document.body.classList.contains("sw-open"))));
  await page.reload();
  await page.waitForTimeout(800);
  await page.click("#planner-resume-btn", { timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(500);
  check("phone: dock stays shut after reload", !(await page.evaluate(() => document.body.classList.contains("sw-open"))));
  check("phone: no page errors", errors.length === 0, errors.join("; "));
  check("phone: nothing submitted", submits.length === 0);
  await ctx.close();
}

// ---- the spoken-line door filter runs, and spending needs a confirm.
{
  const { ctx, page, errors, submits } = await session({ width: 390, spoken: true });
  await gotoRender(page);
  await page.waitForFunction(() => document.querySelector("#planner-motion-backend")?.options.length > 0);
  const list = await doors(page);
  check("spoken board hides the silent door", !list.includes("silent-door") && list.includes("talk-priced"), list.join(","));
  await pickDoor(page, "talk-priced");
  await page.click("#planner-render-btn");
  await page.waitForSelector("#planner-spend-confirm[open]");
  check("confirm states the total", (await page.textContent("#planner-spend-total")).includes("$0.48 to $0.84"), await page.textContent("#planner-spend-total"));
  check("confirm states shots and seconds", (await page.textContent("#planner-spend-what")).includes("2 shots, about 12 seconds"), await page.textContent("#planner-spend-what"));
  check("nothing spends before the confirm", submits.length === 0);
  await page.click('#planner-spend-confirm button[value="cancel"]');
  await page.waitForTimeout(300);
  check("go back spends nothing", submits.length === 0);
  await pickDoor(page, "talk-unpriced");
  await page.click("#planner-render-btn");
  await page.waitForSelector("#planner-spend-confirm[open]");
  check("no rate says so", (await page.textContent("#planner-spend-total")).includes("does not state a rate"));
  await page.click('#planner-spend-confirm button[value="start"]');
  await page.waitForTimeout(800);
  check("start submits once", submits.length === 1, String(submits.length));
  check("default look routes to the GPU door", submits[0]?.renderOverrides?.keyframe_backend === "keyframe", JSON.stringify(submits[0]?.renderOverrides));
  check("spoken: no page errors", errors.length === 0, errors.join("; "));
  await ctx.close();
}

// ---- a silent board keeps silent doors.
{
  const { ctx, page } = await session({ width: 1280, spoken: false });
  await gotoRender(page);
  await page.waitForFunction(() => document.querySelector("#planner-motion-backend")?.options.length > 0);
  check("silent board keeps the silent door", (await doors(page)).includes("silent-door"));
  check("desktop: dock opens by itself", await page.evaluate(() => document.body.classList.contains("sw-open")));
  await ctx.close();
}

// ---- the look decides the route, and an untrained character is refused only on the LoRA route.
{
  const cast = [{ id: "c1", slug: "mara", name: "Mara", portrait_key: "p.png", ref_keys: [], source_keys: [], lora_status: "idle" }];
  const { ctx, page, submits } = await session({ width: 390, spoken: false, cast });
  await gotoRender(page);
  await page.waitForFunction(() => document.querySelector("#planner-motion-backend")?.options.length > 0);
  check("look offers both", (await page.$$eval("#planner-look option", (o) => o.map((e) => e.value))).join() === "photoreal,anime");
  await pickDoor(page, "talk-priced");
  for (let i = 0; i < 2; i++) {
    await page.click("#planner-render-btn");
    await page.waitForTimeout(500);
  }
  check("photoreal: untrained stays refused on every click", submits.length === 0 && !(await page.locator("#planner-spend-confirm[open]").count()));
  check("photoreal: refusal names the way out", (await page.textContent("#planner-lora-preflight-warning")).includes("Anime"));
  await page.selectOption("#planner-look", "anime");
  await page.click("#planner-render-btn");
  await page.waitForSelector("#planner-spend-confirm[open]");
  await page.click('#planner-spend-confirm button[value="start"]');
  await page.waitForTimeout(800);
  const o = submits[0]?.renderOverrides ?? {};
  check("anime routes to cloud-keyframe", o.keyframe_backend === "cloud-keyframe", JSON.stringify(o));
  check("anime sets the door's style", o.config?.["cloud-keyframe"]?.style === "anime", JSON.stringify(o.config));
  await ctx.close();
}

// ---- a finished or failed film: no stale counters, no raw JSON for a filmmaker.
for (const [name, final] of [
  ["done", { status: "COMPLETED", statusRaw: "done", output: { output_key: "renders/f/film.mp4", mode: "full" } }],
  ["failed", { status: "FAILED", statusRaw: "failed", error: "shot_2 failed" }],
]) {
  let n = 0;
  const running = { status: "IN_PROGRESS", statusRaw: "running", output: { phase: "keyframes", scene_total: 2, shots_done: 1 } };
  const { ctx, page } = await session({ width: 390, spoken: true, poll: () => (n++ < 1 ? running : final) });
  await gotoRender(page);
  await page.waitForFunction(() => document.querySelector("#planner-motion-backend")?.options.length > 0);
  await pickDoor(page, "talk-priced");
  await page.click("#planner-render-btn");
  await page.waitForSelector("#planner-spend-confirm[open]");
  await page.click('#planner-spend-confirm button[value="start"]');
  await page.waitForFunction((s) => document.querySelector("#planner-render-job-status")?.textContent.toLowerCase().includes(s), name === "done" ? "done" : "failed", { timeout: 40000 });
  await page.waitForTimeout(300);
  check(`${name}: progress counters are gone`, !(await page.locator("#planner-render-scene").isVisible()) && !(await page.locator("#planner-render-phase").isVisible()));
  check(`${name}: raw output is hidden from a filmmaker`, !(await page.locator("#planner-render-output").isVisible()));
  await ctx.close();
}

await browser.close();
server.close();
console.log(bad ? `${bad} failed` : "all passed");
process.exit(bad ? 1 : 0);
