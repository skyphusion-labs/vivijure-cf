// Make a video (cf#1242) in real Chrome at phone width. Serves public/ as files and stubs /api/*.
// SHOTS=<dir> also writes phone (390px) and desktop screenshots of the page there.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright-core";

const ROOT = join(import.meta.dirname, "..", "..", "public");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = path === "/make" ? "make.html" : normalize(path).replace(/^\/+/, "");
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
let bad = 0;
const check = (name, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
};
process.on("uncaughtException", (e) => { console.log("HARNESS", String(e).split("\n")[0]); process.exit(2); });

// Fixtures copy the real manifest facts the rule reads (usage, ui.order, enums, rates).
const enumOf = (values, d = values[0]) => ({ type: "enum", values, default: d });
const door = (name, usage, extra = {}) => ({ name, hooks: ["motion.backend"], provides: [{ id: name, label: name }], usage, ...extra });
const KF = { name: "keyframe", hooks: ["keyframe"], trains_loras: true, config_schema: { width: { type: "int", min: 512, max: 1536 }, height: { type: "int", min: 512, max: 1536 } } };
const HH1 = door("cf-hh1-r2v", { native_audio: false, first_last: true }, { ui: { order: 60 }, config_schema: { ratio: enumOf(["16:9", "9:16", "1:1"]), resolution: enumOf(["720P", "1080P"]) } });
const VIDU = door("cf-vidu-q3-turbo", { native_audio: true, first_last: true }, { ui: { order: 58, cost_usd_per_second: [0.04, 0.07] }, config_schema: { resolution: enumOf(["540p", "720p", "1080p"], "720p") } });
const SEED = door("cf-seedance", { native_audio: true, first_last: true }, { ui: { order: 70 }, config_schema: { aspect_ratio: enumOf(["16:9", "9:16", "1:1"]) } });
const WIDE = door("wide-only", { native_audio: true, first_last: true }, { config_schema: { ratio: enumOf(["16:9"]) } });
const VEO = door("cf-veo", { native_audio: true }, { config_schema: { aspect_ratio: enumOf(["16:9", "9:16", "1:1"]) } });
const registry = (doors) => ({
  modules: [KF, ...doors],
  hooks: { keyframe: ["keyframe"], "motion.backend": doors.map((d) => d.name) },
  catalog: [],
  render: { quality_tiers: [{ value: "draft", label: "draft" }, { value: "standard", label: "standard" }, { value: "final", label: "final" }], default_tier: "final" },
  host: {},
});
const castRows = () => [{ id: "c1", name: "Mara", bible: "grey coat", portrait_key: "cast/c1/p.png", ref_keys: ["cast/c1/r1.png"], source_keys: [], lora_status: "ready" }];
const spokenBoard = { title: "Cart race", clip_seconds: 5, use_characters: ["A"], scenes: [
  { id: "s1", prompt: "two friends at a parking lot", target_seconds: 6, character_slots: ["A"] },
  { id: "s2", prompt: "the race", target_seconds: 8, character_slots: ["A"], dialogue: { slot: "A", text: "Go!" } },
  { id: "s3", prompt: "laughing", character_slots: ["A"] },
] };
const silentBoard = { ...spokenBoard, scenes: spokenBoard.scenes.map(({ dialogue, ...s }) => s) };

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: process.env.CI ? ["--no-sandbox"] : [],
});

async function open(opts = {}) {
  const doors = opts.doors ?? [HH1, VIDU, SEED];
  const viewport = opts.viewport ?? { width: 390, height: 844 };
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  await ctx.addInitScript(() => { try { localStorage.setItem("vivijure_api_token", "test"); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const calls = [];
  const cast = opts.cast ?? castRows();
  let polls = 0;
  let refsPolls = 0;
  await page.route("**/api/**", async (r) => {
    const req = r.request();
    const { pathname } = new URL(req.url());
    const method = req.method();
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = "(bytes)"; }
    calls.push({ method, pathname, body });
    const json = (o, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    if (pathname.startsWith("/api/artifact/")) return r.fulfill({ status: 200, contentType: "image/png", body: PNG });
    if (pathname === "/api/whoami") return json(opts.simple ? { user: "studio", panel_home: "simple" } : { user: "studio" });
    if (pathname === "/api/modules") return json(registry(doors));
    if (pathname === "/api/cast" && method === "GET") return json({ cast, wan_lora_trainable: false });
    if (pathname === "/api/cast" && method === "POST") { const row = { id: "c9", name: body.name, portrait_key: null, ref_keys: [], source_keys: [] }; cast.unshift(row); return json({ cast: row }, 201); }
    if (pathname === "/api/upload") return json({ key: "uploads/selfie.png" });
    if (pathname === "/api/cast/c9/portrait") { Object.assign(cast[0], { portrait_key: "cast/c9/p.png" }); return json({ cast: cast[0] }); }
    if (pathname === "/api/cast/c9/generate-refs") return json({ ok: true, job_id: "refs-1", phase: "generating", registered: 0, images: [] }, 201);
    if (pathname === "/api/cast/c9/refs-job/refs-1") { refsPolls++; if (refsPolls < 2) return json({ ok: true, job_id: "refs-1", phase: "generating", registered: 1 }); Object.assign(cast[0], { ref_keys: ["cast/c9/r1.png"] }); return json({ ok: true, job_id: "refs-1", phase: "done", registered: 4 }); }
    if (pathname === "/api/cast/c9") return json({ cast: cast[0] });
    if (pathname === "/api/storyboard/models") return json({ models: opts.noModel ? [] : [{ id: "plan-model-1", label: "Planner" }] });
    if (pathname === "/api/storyboard/plan") return opts.planFail ? json({ ok: false, errors: ["the model said no"] }, 422) : json({ ok: true, storyboard: opts.board ?? spokenBoard });
    if (pathname === "/api/storyboard/projects" && method === "POST") return json({ project: { id: 41, name: body.name } }, 201);
    if (pathname === "/api/storyboard/projects/41/storyboard") return json({ project: { id: 41, name: "Cart race" } });
    if (pathname === "/api/storyboard/bundle") return json({ ok: true, bundleKey: "bundles/cart/bundle.tar.gz" }, 201);
    if (pathname === "/api/storyboard/render" && method === "POST") return json({ ok: true, jobId: "film-77", status: "IN_QUEUE" }, 201);
    if (pathname === "/api/storyboard/render/film-77") {
      polls++;
      if (opts.failRender) return json({ jobId: "film-77", status: "FAILED", error: "a clip could not be made", output: {} });
      if (polls < 2) return json({ jobId: "film-77", status: "IN_PROGRESS", output: { phase: "i2v", progress: 0.5 } });
      return json({ jobId: "film-77", status: "COMPLETED", output: { output_key: "films/cart/final.mp4", project: "cart" } });
    }
    return json({});
  });
  // Speed the poll loops up for the test. The page's own cadence is the shared primitive's default.
  await page.addInitScript(() => {
    const realSetTimeout = window.setTimeout;
    window.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(Number(ms) || 0, 200), ...a);
  });
  await page.goto(`${B}/make`);
  await page.waitForFunction(() => document.querySelector("#make-shapes input") || !document.querySelector("#make-unavailable").hidden);
  return { ctx, page, calls, errors };
}
const text = (page, sel) => page.locator(sel).innerText();
const JARGON = /\b(storyboard|shots?|slots?|seeds?|keyframes?|backends?|doors?|lora|yaml|render(s|ed|ing)?)\b|\.(mp4|png|json|yaml|tar)\b/i;

{
  const { ctx, page, calls, errors } = await open();
  check("page boots with no script errors", errors.length === 0, errors.join(" | "));
  check("vertical is the default shape", await page.isChecked("#make-shape-vertical"));
  check("all three shapes offered", (await page.$$eval("#make-shapes input", (els) => els.map((e) => e.value))).join() === "vertical,square,wide");
  check("Draft, Good, Best offered", (await page.$$eval("#make-qualities strong", (els) => els.map((e) => e.textContent))).join() === "Draft,Good,Best");
  check("style is face consistency first", (await text(page, "#make-style-line")) === "Style: No talking, faces locked", await text(page, "#make-style-line"));
  check("change opens the advanced planner", (await page.getAttribute("#make-style-change", "href")) === "planner");
  check("make is off with nobody in it", await page.locator("#make-go").isDisabled());
  check("says why", (await text(page, "#make-why")).includes("Add at least one person"));
  check("fits a phone", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("faces are shown as pictures", (await page.locator("#make-faces img").count()) === 1);
  check("plain words only", !JARGON.test(await page.locator("body").innerText()), (await page.locator("body").innerText()).match(JARGON)?.[0]);
  await page.click('#make-faces button[aria-label="Add Mara"]');
  await page.fill("#make-idea", "Mara races a shopping cart at sunset.");
  check("make is on once ready", await page.locator("#make-go").isEnabled(), await text(page, "#make-why"));
  check("total waits for the plan", (await text(page, "#make-total")).includes("after your idea is planned"));
  await page.click("#make-go");
  await page.waitForSelector("#make-confirm[open]");
  check("the plan has talking, so the style moves to a talking one", (await text(page, "#make-confirm-style")) === "Style: Talking, consistent faces.", await text(page, "#make-confirm-style"));
  check("confirm shows one total from the stated rate", (await text(page, "#make-confirm-total")) === "Total: up to $1.33", await text(page, "#make-confirm-total"));
  check("confirm says what it is", (await text(page, "#make-confirm-what")).includes("About 19 seconds, vertical, good quality, with Mara"), await text(page, "#make-confirm-what"));
  check("confirm is plain words", !JARGON.test(await page.locator("#make-confirm").innerText()));
  check("nothing spent before confirm", !calls.some((c) => ["/api/storyboard/render", "/api/storyboard/bundle", "/api/storyboard/projects"].includes(c.pathname) && c.method === "POST"));
  await page.click('#make-confirm button[value="go"]');
  await page.waitForSelector("#make-result:not([hidden])", { timeout: 15000 });
  const post = (p) => calls.find((c) => c.method === "POST" && c.pathname === p)?.body;
  check("the board is saved to a project", post("/api/storyboard/projects")?.name === "Cart race" && post("/api/storyboard/projects/41/storyboard")?.storyboard?.scenes?.length === 3);
  check("plan used the idea and the person", post("/api/storyboard/plan")?.brief.includes("shopping cart") && post("/api/storyboard/plan")?.characters?.[0]?.name === "Mara" && post("/api/storyboard/plan")?.model === "plan-model-1");
  check("faces packed from the person's pictures", post("/api/storyboard/bundle")?.characterRefs?.A?.trainingImages?.length === 2);
  const r = post("/api/storyboard/render") ?? {};
  check("submitted on the chosen style", r.motion_backend === "cf-vidu-q3-turbo" && r.renderOverrides?.motion_backend === "cf-vidu-q3-turbo", JSON.stringify(r));
  check("vertical pictures and the quality's resolution", r.renderOverrides?.config?.keyframe?.width === 768 && r.renderOverrides?.config?.keyframe?.height === 1344 && r.renderOverrides?.config?.["cf-vidu-q3-turbo"]?.resolution === "720p", JSON.stringify(r.renderOverrides));
  check("good is the standard tier", r.qualityTier === "standard");
  check("the trained look is used when ready", r.castLoras?.A === "c1");
  check("pinned to the project and keyed once", r.projectId === 41 && typeof r.idempotency_key === "string" && r.idempotency_key.length > 8);
  check("scenes carry their seconds", r.scenes?.map((s) => s.seconds).join() === "6,8,5", JSON.stringify(r.scenes));
  check("player plays the result", (await page.getAttribute("#make-player", "src")) === "/api/artifact/films/cart/final.mp4");
  check("download is the same video", (await page.getAttribute("#make-download", "href")) === "/api/artifact/films/cart/final.mp4");
  check("edit opens the advanced planner", (await page.getAttribute("#make-edit", "href")) === "planner");
  check("says where it was saved", (await text(page, "#make-saved")).includes("Cart race"));
  check("result is plain words", !JARGON.test(await page.locator("#make-result").innerText()), (await page.locator("#make-result").innerText()).match(JARGON)?.[0]);
  check("no script errors through the whole run", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
{
  // A style with no stated price: the total says so, and never a number.
  const { ctx, page } = await open({ doors: [SEED] });
  await page.click('#make-faces button[aria-label="Add Mara"]');
  await page.fill("#make-idea", "A walk.");
  check("no price before the plan", (await text(page, "#make-qualities")).includes("price unknown"));
  await page.click("#make-go");
  await page.waitForSelector("#make-confirm[open]");
  check("total says price unknown", (await text(page, "#make-confirm-total")) === "Total: price unknown", await text(page, "#make-confirm-total"));
  check("and why", (await text(page, "#make-confirm-note")).includes("states no price"));
  await page.click('#make-confirm button[value="cancel"]');
  await page.waitForTimeout(150);
  check("go back starts nothing", (await text(page, "#make-why")).includes("Nothing started"));
  await ctx.close();
}
{
  // Only a wide-only consistent door, plus a vertical-capable door that is not consistency grade.
  const { ctx, page } = await open({ doors: [WIDE, VEO] });
  check("a shape no consistent style makes is not offered", (await page.$$eval("#make-shapes input", (els) => els.map((e) => e.value))).join() === "wide");
  check("wide is then chosen", await page.isChecked("#make-shape-wide"));
  await ctx.close();
}
{
  // No consistent style at all: the page says so instead of picking a weaker one.
  const { ctx, page } = await open({ doors: [VEO] });
  check("nothing offered", (await page.locator("#make-shapes input").count()) === 0);
  check("says so plainly", (await text(page, "#make-unavailable")).includes("no video style that keeps faces consistent"));
  await ctx.close();
}
{
  // Add someone: name plus one selfie runs the cast steps and waits for the face.
  const { ctx, page, calls } = await open({ cast: [] });
  await page.click("#make-add summary");
  await page.fill("#make-add-name", "Sam");
  await page.setInputFiles("#make-add-photo", { name: "me.png", mimeType: "image/png", buffer: PNG });
  await page.click("#make-add-go");
  await page.waitForFunction(() => document.querySelector("#make-chosen")?.textContent.includes("Sam"));
  const prep = await text(page, "#make-chosen");
  check("progress in plain words", /Getting Sam's face ready \(about 2-4 min\)|Face ready/.test(prep), prep);
  await page.waitForFunction(() => document.querySelector("#make-chosen")?.textContent.includes("Face ready"), null, { timeout: 10000 });
  const order = calls.filter((c) => c.method === "POST").map((c) => c.pathname);
  check("create, upload, portrait, then pictures", order.join() === "/api/cast,/api/upload,/api/cast/c9/portrait,/api/cast/c9/generate-refs", order.join());
  check("portrait uses the uploaded selfie", calls.find((c) => c.pathname === "/api/cast/c9/portrait")?.body?.from_chat_artifact === "uploads/selfie.png");
  await page.fill("#make-idea", "Sam waves.");
  check("ready face lets the video start", await page.locator("#make-go").isEnabled(), await text(page, "#make-why"));
  await ctx.close();
}
{
  // A failed video is told plainly with a way back.
  const { ctx, page } = await open({ board: silentBoard, failRender: true });
  await page.click('#make-faces button[aria-label="Add Mara"]');
  await page.fill("#make-idea", "A quiet walk.");
  await page.click("#make-go");
  await page.waitForSelector("#make-confirm[open]");
  check("a silent plan keeps the locked style", (await text(page, "#make-confirm-style")) === "Style: No talking, faces locked.");
  await page.click('#make-confirm button[value="go"]');
  await page.waitForSelector("#make-progress-error:not([hidden])", { timeout: 15000 });
  check("failure is told", (await text(page, "#make-progress-error")).includes("did not finish"));
  check("start over is offered", await page.locator("#make-again").isVisible());
  await ctx.close();
}
{
  // The PANEL_HOME nav: simple puts Make a video first and calls the planner Advanced.
  const simple = await open({ simple: true });
  await simple.page.waitForFunction(() => document.querySelector("[data-studio-nav] a")?.textContent === "Make a video");
  const items = await simple.page.$$eval("[data-studio-nav] a", (els) => els.map((e) => e.textContent));
  check("simple nav", items.join() === "Make a video,Advanced,Cast,Films", items.join());
  await simple.ctx.close();
  const plain = await open({ simple: false });
  await plain.page.waitForTimeout(300);
  const items2 = await plain.page.$$eval("[data-studio-nav] a", (els) => els.map((e) => e.textContent));
  check("unset nav is unchanged", items2.join() === "Planner,Cast,Films", items2.join());
  await plain.ctx.close();
}
if (process.env.SHOTS) {
  await mkdir(process.env.SHOTS, { recursive: true });
  for (const [name, viewport] of [["make-phone-390.png", { width: 390, height: 844 }], ["make-desktop-1280.png", { width: 1280, height: 900 }]]) {
    const { ctx, page } = await open({ viewport, simple: true });
    await page.click('#make-faces button[aria-label="Add Mara"]');
    await page.fill("#make-idea", "Mara races a shopping cart across an empty parking lot at sunset. Fun and a bit silly.");
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(process.env.SHOTS, name), fullPage: true });
    console.log("SHOT", join(process.env.SHOTS, name));
    await ctx.close();
  }
}
await browser.close();
server.close();
console.log(bad ? `${bad} failed` : "all passed");
process.exit(bad ? 1 : 0);
