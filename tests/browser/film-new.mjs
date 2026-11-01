// The start form in real Chrome at phone width. Serves public/ as files and stubs /api/*.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright-core";

const ROOT = join(import.meta.dirname, "..", "..", "public");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = path === "/films" ? "films.html" : normalize(path).replace(/^\/+/, "");
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

const door = (name, usage, ui = {}) => ({ name, hooks: ["motion.backend"], provides: [{ id: name, label: `Door ${name}` }], usage, ui });
const registry = {
  modules: [door("silent", { native_audio: false }), door("talk", { native_audio: true }, { cost_usd_per_second: [0.04, 0.07] })],
  hooks: { "motion.backend": ["silent", "talk"] }, catalog: [],
  render: { quality_tiers: [{ value: "final", label: "Best" }], default_tier: "final", max_scenes_per_part: 40, max_parts: 64 }, host: {},
};
const scenes = (n, spoken) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, prompt: "p", target_seconds: 6, character_slots: ["A"], ...(spoken && i === 0 ? { dialogue: { slot: "A", text: "Hello." } } : {}) }));
const master = (n, spoken = false) => JSON.stringify({ use_characters: ["A"], characters: { A: { name: "Mara" } }, scenes: scenes(n, spoken) });
const castRows = [{ id: "c1", name: "Mara", bible: "grey coat", portrait_key: "p.png", ref_keys: ["r.png"], source_keys: [] }];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: process.env.CI ? ["--no-sandbox"] : [],
});
async function open(state = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => { try { localStorage.setItem("vivijure_api_token", "test"); } catch {} });
  const page = await ctx.newPage();
  const posts = [];
  await page.route("**/api/**", (r) => {
    const { pathname } = new URL(r.request().url());
    const json = (o, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    if (pathname === "/api/modules") return json(registry);
    if (pathname === "/api/cast") return json({ cast: castRows });
    if (pathname === "/api/storyboard/projects") return json({ projects: [{ id: 7, name: "The Harbor Film", last_storyboard: JSON.parse(master(4)) }, { id: 8, name: "Empty" }] });
    if (pathname === "/api/film" && r.request().method() === "POST") {
      posts.push(JSON.parse(r.request().postData()));
      return state.refuse ? json({ error: state.refuse }, state.status ?? 400) : json({ ok: true, film_id: "feature-9", phase: "planned", parts: [], created: true }, 201);
    }
    if (pathname === "/api/film/feature-9") return json({ film_id: "feature-9", project: "Harbor", phase: "planned", parts: [], shots_done: 0, shots_total: 4 });
    return json({});
  });
  await page.goto(`${B}/films?new=1`);
  await page.waitForFunction(() => document.querySelector("#new-part-size")?.value);
  return { ctx, page, posts };
}
const filled = async (page, n = 90, spoken = false) => {
  await page.fill("#new-project", "Harbor");
  await page.fill("#new-board", master(n, spoken));
  await page.fill("#new-per-shot", "0.42");
  await page.fill("#new-ceiling", "60");
};
const text = (page, sel) => page.locator(sel).innerText();

{
  const { ctx, page, posts } = await open();
  check("start is off on an empty form", await page.locator("#new-start").isDisabled());
  check("part size respects the cap", (await page.inputValue("#new-part-size")) === "30");
  await filled(page);
  check("names the shots and parts", (await text(page, "#new-facts")).includes("90 shots, about 9 minutes, 3 parts"), await text(page, "#new-facts"));
  check("guesses cast from the board's name", (await page.inputValue('#new-cast select[data-slot="A"]')) === "c1");
  check("no rate says so", (await text(page, "#new-per-shot-hint")).includes("states no rate"));
  await page.selectOption("#new-door", "talk");
  check("a rate suggests a figure", (await text(page, "#new-per-shot-hint")).includes("$0.42"), await text(page, "#new-per-shot-hint"));
  check("start is on when complete", await page.locator("#new-start").isEnabled(), await text(page, "#new-problems"));
  check("fits a phone", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.click("#new-start");
  await page.waitForSelector("#new-confirm[open]");
  const cost = await text(page, "#new-confirm-cost");
  check("confirm states estimate and ceiling, as an estimate", cost.includes("$37.80") && cost.includes("$60.00") && cost.includes("not a measured price"), cost);
  check("confirm states the hold", (await text(page, "#new-confirm-hold")).includes("stops after the first part"));
  check("nothing posted before confirm", posts.length === 0);
  await page.click('#new-confirm button[value="cancel"]');
  await page.waitForTimeout(200);
  check("go back posts nothing", posts.length === 0);
  await page.click("#new-start");
  await page.click('#new-confirm button[value="go"]');
  await page.waitForURL("**/films?id=feature-9");
  const p = posts[0];
  check("request carries the required fields", p.project === "Harbor" && p.part_size === 30 && p.spend_ceiling_usd === 60 && p.cost_usd_per_shot_est === 0.42 && p.pause_after_first_part === true && p.storyboard.scenes.length === 90, JSON.stringify({ ...p, storyboard: 0 }));
  check("request carries shared", p.shared.motion_backend === "talk" && p.shared.style === "photoreal" && p.shared.delivery_width === 1920 && p.shared.delivery_height === 1080 && p.shared.qualityTier === "final" && !("audio_key" in p.shared), JSON.stringify(p.shared));
  check("cast as the bundle route takes it", p.character_refs.A.trainingImages.length === 2 && p.character_refs.A.name === "Mara" && p.shared.cast_loras.A === "c1", JSON.stringify(p.character_refs));
  check("has an idempotency key", typeof p.idempotency_key === "string" && p.idempotency_key.length > 8);
  check("goes to the film", page.url().endsWith("films?id=feature-9"));
  await ctx.close();
}
{
  const { ctx, page } = await open();
  await filled(page, 90, true);
  check("spoken board hides the silent door", (await page.$$eval("#new-door option", (o) => o.map((e) => e.value))).join() === "talk");
  await page.fill("#new-part-size", "41");
  check("over the part cap is refused", (await text(page, "#new-problems")).includes("The limit is 40") && (await page.locator("#new-start").isDisabled()));
  await page.fill("#new-part-size", "1");
  check("over the parts cap is refused", (await text(page, "#new-problems")).includes("The limit is 64"));
  await page.fill("#new-part-size", "30");
  await page.fill("#new-breaks", "30,90");
  check("breaks count parts", (await text(page, "#new-facts")).includes("3 parts"));
  await page.fill("#new-breaks", "");
  await page.selectOption('#new-cast select[data-slot="A"]', "");
  check("empty cast slot is refused", (await text(page, "#new-problems")).includes("slot A"));
  await page.selectOption('#new-cast select[data-slot="A"]', "c1");
  await page.fill("#new-board", "{ not json");
  check("bad board is refused", (await text(page, "#new-problems")).includes("Master board"));
  await page.fill("#new-board", JSON.stringify({ scenes: [{ prompt: "p", target_seconds: 6 }] }));
  check("a shot with no id is refused", (await text(page, "#new-problems")).includes("own id"));
  await page.fill("#new-board", JSON.stringify({ scenes: [{ id: "a", prompt: "p" }] }));
  check("a shot with no seconds is refused", (await text(page, "#new-problems")).includes("seconds"));
  await ctx.close();
}
{
  const { ctx, page, posts } = await open({ refuse: "this board predicts too many bytes" });
  await filled(page);
  await page.selectOption("#new-door", "talk");
  await page.click("#new-start");
  await page.click('#new-confirm button[value="go"]');
  await page.waitForFunction(() => document.querySelector("#new-note")?.textContent.includes("Not started"));
  check("server refusal is shown", (await text(page, "#new-note")).includes("too many bytes"));
  check("stays on the form", page.url().includes("new=1"));
  await page.click("#new-start");
  await page.click('#new-confirm button[value="go"]');
  await page.waitForTimeout(300);
  check("same key on a second try", posts.length === 2 && posts[0].idempotency_key === posts[1].idempotency_key);
  await page.click("#films-new details summary");
  await page.fill("#new-overrides", "not json");
  await page.click("#new-start");
  check("bad per-part JSON stops before confirm", (await text(page, "#new-problems")).includes("JSON list") && !(await page.locator("#new-confirm[open]").count()));
  await ctx.close();
}
{
  const { ctx, page, posts } = await open();
  await page.selectOption("#new-from-project", "7");
  check("project loads its board", (await page.inputValue("#new-board")).includes('"scenes"'));
  check("project names the film safely", (await page.inputValue("#new-project")) === "The_Harbor_Film");
  check("a project with no board is not offered", (await page.$$eval("#new-from-project option", (o) => o.map((e) => e.textContent))).join("|") === "paste below instead|The Harbor Film");
  await page.fill("#new-per-shot", "1");
  await page.fill("#new-ceiling", "10");
  await page.check("#new-pause");
  await page.uncheck("#new-pause");
  await page.fill("#new-breaks", "2");
  await page.click("#new-start");
  check("no hold is stated plainly", (await text(page, "#new-confirm-hold")).includes("Every part runs"));
  await page.click('#new-confirm button[value="go"]');
  await page.waitForURL("**/films?id=feature-9");
  check("breaks and no hold are sent", posts[0].breaks?.join() === "2" && !("part_size" in posts[0]) && posts[0].pause_after_first_part === false, JSON.stringify({ ...posts[0], storyboard: 0 }));
  await ctx.close();
}
// ---- a reload after a lost response reuses the key. A success or a 409 ends it.
{
  const { ctx, page, posts } = await open({ refuse: "lost", status: 500 });
  await filled(page);
  await page.click("#new-start");
  await page.click('#new-confirm button[value="go"]');
  await page.waitForFunction(() => document.querySelector("#new-note")?.textContent.includes("Not started"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#new-part-size")?.value);
  await filled(page);
  await page.click("#new-start");
  await page.click('#new-confirm button[value="go"]');
  await page.waitForFunction(() => document.querySelector("#new-note")?.textContent.includes("Not started"));
  check("same key across a reload", posts.length === 2 && posts[0].idempotency_key === posts[1].idempotency_key, JSON.stringify(posts.map((p) => p.idempotency_key)));
  await ctx.close();
}
{
  const { ctx, page, posts } = await open({ refuse: "different request", status: 409 });
  await filled(page);
  await page.click("#new-start");
  await page.click('#new-confirm button[value="go"]');
  await page.waitForFunction(() => document.querySelector("#new-note")?.textContent.includes("other settings"));
  check("409 warns before a second film", (await text(page, "#new-note")).includes("starts a new film"));
  await page.click("#new-start");
  await page.click('#new-confirm button[value="go"]');
  await page.waitForTimeout(300);
  check("after a 409 the key is new", posts.length === 2 && posts[0].idempotency_key !== posts[1].idempotency_key);
  await ctx.close();
}
{
  const { ctx, page } = await open();
  await filled(page);
  await page.click("#new-start");
  await page.click('#new-confirm button[value="go"]');
  await page.waitForURL("**/films?id=feature-9");
  check("a success ends the key", await page.evaluate(() => sessionStorage.getItem("skyphusion.films.startKey") === null));
  await ctx.close();
}

// ---- the estimate over the ceiling warns, and per-part changes show on the confirm.
{
  const { ctx, page, posts } = await open();
  await filled(page);
  check("under the ceiling: no warning", (await text(page, "#new-warn")) === "");
  await page.fill("#new-ceiling", "10");
  check("over the ceiling warns on the form", (await text(page, "#new-warn")).includes("$37.80") && (await text(page, "#new-warn")).includes("stop before it finishes"));
  check("over the ceiling still allowed", await page.locator("#new-start").isEnabled());
  await page.click("#films-new details summary");
  await page.fill("#new-overrides", JSON.stringify([{ index: 2, motion_backend: "talk" }]));
  await page.click("#new-start");
  await page.waitForSelector("#new-confirm[open]");
  check("confirm repeats the warning", (await text(page, "#new-confirm-warn")).includes("above the $10.00 ceiling"));
  check("confirm shows per-part changes, numbered as people count", (await text(page, "#new-confirm-overrides")).includes("part 3 (motion_backend)"), await text(page, "#new-confirm-overrides"));
  await page.click('#new-confirm button[value="cancel"]');
  await page.fill("#new-overrides", '{"index":2}');
  await page.click("#new-start");
  check("per-part changes must be a list", (await text(page, "#new-problems")).includes("JSON list") && !(await page.locator("#new-confirm[open]").count()));
  check("nothing posted", posts.length === 0);
  await ctx.close();
}

await browser.close();
server.close();
console.log(bad ? `${bad} failed` : "all passed");
process.exit(bad ? 1 : 0);
