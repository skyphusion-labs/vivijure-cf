// The film board in real Chrome at phone width. Serves public/ as files and stubs /api/*.
import { writeSync } from "node:fs";
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

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let bad = 0;
const check = (name, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
};
process.on("uncaughtException", (e) => { writeSync(1, "HARNESS " + String(e).split("\n")[0] + "\n"); process.exit(2); });

const part = (index, status, extra = {}) => ({
  part_id: `p${index}`, index, shot_from: index * 30, shot_to: index * 30 + 29, status, phase: status === "running" ? "keyframe" : null,
  shots_done: status === "done" ? 30 : 4, shots_total: 30, cost_est: 12, cost_actual: null, output_key: status === "done" ? `renders/p${index}/film.mp4` : null, error: null, ...extra,
});
const film = (extra = {}) => ({
  ok: true, film_id: "feature-1", project: "Harbor", phase: "running", stop_reason: null, created_at: 1, started_at: 1, elapsed_ms: 5400000,
  shots_done: 34, shots_total: 90, cost_est: 36, cost_actual: null, spend_ceiling_usd: 500, spend_committed_est: 48, spend_ceiling_basis: "An estimate. It counts retries in full.",
  parts: [part(0, "done"), part(1, "running"), part(2, "pending")],
  output_key: null, sidecar_key: null, bytes: null, duration_seconds: null, degraded: null, error: null, ...extra,
});

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: process.env.CI ? ["--no-sandbox"] : [],
});

async function open(state, url = "/films?id=feature-1") {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => { try { localStorage.setItem("vivijure_api_token", "test"); } catch {} });
  const page = await ctx.newPage();
  const seen = { retries: [], films: [], gets: 0, errors: [], resumes: 0, ceilings: [], shotReads: [], retakes: [], cancels: 0, thumbs: [], artifacts: [] };
  page.on("pageerror", (e) => seen.errors.push(String(e)));
  page.on("request", (r) => { if (/\.mp4/.test(r.url())) seen.films.push(r.url()); });
  await page.route("**/api/**", (r) => {
    const { pathname } = new URL(r.request().url());
    const json = (o, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    if (pathname === "/api/modules") return json({ modules: [], hooks: {}, catalog: [], render: {}, host: {} });
    if (pathname === "/api/film") return state.list ? json({ ok: true, films: state.list }) : json({ error: "not found" }, 404);
    if (pathname === "/api/film/feature-1") { seen.gets++; return state.film ? json(state.film) : json({ error: "film" }, 404); }
    const retry = /^\/api\/film\/feature-1\/parts\/(\d+)\/retry$/.exec(pathname);
    if (retry) {
      seen.retries.push({ index: Number(retry[1]), body: JSON.parse(r.request().postData()) });
      if (state.retryRefuse) return json({ error: "part has not failed" }, 400);
      state.film = film();
      return json({ ok: true });
    }
    const shotsRoute = /^\/api\/film\/feature-1\/parts\/(\d+)\/shots$/.exec(pathname);
    if (shotsRoute) {
      seen.shotReads.push(Number(shotsRoute[1]));
      if (state.holdShots) return state.holdShots.then(() => json({ ok: true, shots: state.shots(Number(shotsRoute[1])) }));
      return state.shots ? json({ ok: true, shots: state.shots(Number(shotsRoute[1])) }) : json({ error: "part" }, 404);
    }
    if (pathname === "/api/voices") return json({ voices: [{ id: "athena", label: "Athena" }] });
    const retake = /^\/api\/film\/feature-1\/shots\/([^/]+)\/retake$/.exec(pathname);
    if (retake) {
      seen.retakes.push({ shot: decodeURIComponent(retake[1]), body: JSON.parse(r.request().postData()) });
      if (state.retakeRefuse) return json({ error: state.retakeRefuse }, 400);
      if (state.afterRetake) state.film = state.afterRetake;
      return json({ ok: true, ...(state.retakeNote ? { note: state.retakeNote } : {}) });
    }
    if (/^\/api\/film\/feature-1\/parts\/\d+\/retake\/cancel$/.test(pathname)) {
      seen.cancels++;
      if (state.afterCancel) state.film = state.afterCancel;
      return json({ ok: true });
    }
    if (pathname === "/api/film/feature-1/resume") {
      seen.resumes++;
      if (state.resumeRefuse) return json({ error: "nothing to resume" }, 400);
      state.film = film();
      return json({ ok: true });
    }
    if (pathname === "/api/film/feature-1/ceiling") {
      seen.ceilings.push(JSON.parse(r.request().postData()));
      if (state.ceilingRefuse) return json({ error: "must be above the current ceiling" }, 400);
      state.film = film({ spend_ceiling_usd: 900 });
      return json({ ok: true });
    }
    if (pathname.startsWith("/api/thumb/")) {
      seen.thumbs.push(pathname);
      if (state.thumbDown) return json({ error: "no images", original: "x" }, 503);
      return r.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
    }
    if (pathname.startsWith("/api/artifact/")) {
      seen.artifacts.push(pathname);
      if (state.artifactOk) return r.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
      return r.fulfill({ status: 404, body: "" });
    }
    return json({});
  });
  await page.goto(B + url);
  return { ctx, page, seen };
}
const text = (page, sel) => page.locator(sel).innerText();
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

// ---- running.
{
  const { ctx, page, seen } = await open({ film: film() });
  await page.waitForSelector(".films-part");
  check("running: phase in words", (await text(page, "#film-phase")) === "Rendering");
  check("running: shots", (await text(page, "#film-shots")) === "34 of 90 shots");
  check("running: elapsed", (await text(page, "#film-elapsed")) === "Running for 1 h 30 min", await text(page, "#film-elapsed"));
  const cost = await text(page, "#film-cost");
  check("cost is labelled an estimate, and null actual is not $0", cost.includes("Estimate $36.00") && cost.includes("not known") && !cost.includes("$0"), cost);
  check("every part is listed", (await page.locator(".films-part").count()) === 3);
  check("count line", (await text(page, "#film-parts-count")).includes("1 done, 1 rendering, 0 failed"));
  check("no retry on a healthy film", (await page.getByRole("button", { name: "Retry failed shots" }).count()) === 0);
  check("no film fetched to draw the list", seen.films.length === 0, seen.films.join());
  check("fits a phone", await noOverflow(page));
  await page.getByRole("button", { name: "Watch this part" }).click();
  await page.waitForSelector(".films-part video");
  check("watch builds a player", true);
  await page.evaluate(() => { window.__v = document.querySelector(".films-part video"); });
  const before = seen.gets;
  await page.waitForFunction(() => false, null, { timeout: 21000 }).catch(() => {});
  check("a running film keeps polling", seen.gets > before, `${before} ${seen.gets}`);
  check("a poll keeps the playing video", await page.evaluate(() => window.__v.isConnected));
  check("no page errors", seen.errors.length === 0, seen.errors.join("; "));
  await ctx.close();
}

// ---- stopped with a failed part, and one still running.
{
  const state = { film: film({ phase: "stopped", stop_reason: "part 2 failed", parts: [part(0, "done"), part(1, "failed", { error: "shot 40 failed" }), part(2, "running")] }) };
  const { ctx, page, seen } = await open(state);
  await page.waitForSelector(".films-part");
  check("stopped: reason shown verbatim", (await text(page, "#film-stop-reason")) === "part 2 failed");
  const note = await text(page, "#film-stop-note");
  check("stopped: says no new parts and what is running", note.includes("No new parts") && note.includes("1 part is still rendering"), note);
  check("stopped: part error shown", (await text(page, ".films-part-failed")).includes("shot 40 failed"));
  await page.locator("#film-only-trouble").check();
  check("filter hides finished parts", (await page.locator(".films-part").count()) === 2);
  await page.locator("#film-only-trouble").uncheck();
  check("filter restores them", (await page.locator(".films-part").count()) === 3);
  await page.getByRole("button", { name: "Retry failed shots" }).click();
  await page.waitForSelector("#film-retry-dialog[open]");
  check("retry asks first", seen.retries.length === 0);
  await page.click('#film-retry-dialog button[value="cancel"]');
  await page.waitForTimeout(200);
  check("go back does not retry", seen.retries.length === 0);
  const gets = seen.gets;
  await page.waitForFunction(() => false, null, { timeout: 21000 }).catch(() => {});
  check("stopped with a running part keeps polling", seen.gets > gets);
  await page.getByRole("button", { name: "Retry failed shots" }).click();
  await page.waitForSelector("#film-retry-dialog[open]");
  await page.click('#film-retry-dialog button[value="go"]');
  await page.waitForFunction(() => document.querySelector("#film-phase")?.textContent === "Rendering");
  check("retry posts the right part and body", seen.retries[0]?.index === 1 && seen.retries[0]?.body?.shots === "failed", JSON.stringify(seen.retries));
  check("stop banner clears after retry", !(await page.locator("#film-stop").isVisible()));
  await ctx.close();
}

// ---- a refused retry says why.
{
  const state = { retryRefuse: true, film: film({ phase: "stopped", stop_reason: "part 1 failed", parts: [part(0, "failed")] }) };
  const { ctx, page } = await open(state);
  await page.getByRole("button", { name: "Retry failed shots" }).click();
  await page.click('#film-retry-dialog button[value="go"]');
  await page.waitForFunction(() => document.querySelector("#film-load-note")?.textContent.includes("did not change"));
  check("refused retry names the reason", (await text(page, "#film-load-note")).includes("part has not failed"));
  await ctx.close();
}

// ---- the hold after the first part: it must have a visible way on, and resume asks first.
{
  const state = { film: film({ phase: "stopped", stop_reason: "the first part is ready: watch it, then resume", parts: [part(0, "done"), part(1, "pending")] }) };
  const { ctx, page, seen } = await open(state);
  await page.waitForSelector(".films-part");
  check("hold: reason shown", (await text(page, "#film-stop-reason")).includes("first part is ready"));
  check("hold: resume is visible", await page.locator("#film-resume").isVisible());
  check("hold: spend and basis shown", (await text(page, "#film-spend")).includes("Committed $48.00 of a $500.00 ceiling") && (await text(page, "#film-basis")).includes("counts retries"));
  const gets = seen.gets;
  await page.waitForFunction(() => false, null, { timeout: 21000 }).catch(() => {});
  check("nothing moving means no polling", seen.gets === gets, `${gets} ${seen.gets}`);
  await page.click("#film-resume");
  await page.waitForSelector("#film-retry-dialog[open]");
  check("resume asks first", seen.resumes === 0);
  await page.click('#film-retry-dialog button[value="cancel"]');
  await page.waitForTimeout(200);
  check("go back does not resume", seen.resumes === 0);
  await page.click("#film-resume");
  await page.click('#film-retry-dialog button[value="go"]');
  await page.waitForFunction(() => document.querySelector("#film-phase")?.textContent === "Rendering");
  check("resume posts once", seen.resumes === 1);
  check("resume button goes away", !(await page.locator("#film-resume").isVisible()));
  await ctx.close();
}

// ---- a stopped film with a failed part offers retry, not resume.
{
  const { ctx, page } = await open({ film: film({ phase: "stopped", stop_reason: "part 1 failed", parts: [part(0, "failed")] }) });
  await page.waitForSelector(".films-part");
  check("failed part: no resume button", !(await page.locator("#film-resume").isVisible()));
  await ctx.close();
}

// ---- a failed join: nothing lost, join again. A truly failed film offers nothing.
{
  const { ctx, page } = await open({ film: film({ phase: "failed", error: "join failed", parts: [part(0, "done"), part(1, "done")] }) });
  await page.waitForSelector(".films-part");
  check("failed join offers to join again", (await text(page, "#film-resume")) === "Join the parts again");
  check("failed join cannot raise a ceiling", !(await page.locator("#film-ceiling").isVisible()));
  await ctx.close();
  const other = await open({ film: film({ phase: "failed", error: "boom", parts: [part(0, "done"), part(1, "failed")] }) });
  await other.page.waitForSelector(".films-part");
  check("a failed part is not a failed join", !(await other.page.locator("#film-resume").isVisible()));
  await other.ctx.close();
}

// ---- a held part clears by itself, and offers no retry.
{
  const { ctx, page } = await open({ film: film({ phase: "running", stop_reason: "rate limited", parts: [part(0, "done"), part(1, "pending")] }) });
  await page.waitForSelector(".films-part");
  check("held: reason shown on a running film", (await text(page, "#film-stop-reason")) === "rate limited");
  check("held: says it clears by itself", (await text(page, "#film-stop-note")).includes("clears by itself"));
  check("held: no retry, no resume", (await page.getByRole("button", { name: "Retry failed shots" }).count()) === 0 && !(await page.locator("#film-resume").isVisible()));
  await ctx.close();
}

// ---- an unknown submit warns before a retry can buy the part twice.
{
  const { ctx, page } = await open({ film: film({ phase: "stopped", stop_reason: "part 1 failed", parts: [part(0, "failed", { error: "submit outcome unknown" })] }) });
  await page.waitForSelector(".films-part");
  check("unknown: error shown as it came", (await text(page, ".films-part-failed")).includes("submit outcome unknown"));
  await page.getByRole("button", { name: "Retry failed shots" }).click();
  await page.waitForSelector("#film-retry-dialog[open]");
  check("unknown: warns it can buy twice", (await text(page, "#film-retry-note")).includes("buy it twice"));
  await ctx.close();
}

// ---- stop_code decides, and the text fallback holds until the code is live.
for (const [name, extra] of [
  ["by code", { stop_code: "spend_ceiling", stop_reason: "over budget" }],
  ["by text", { stop_reason: "spend ceiling reached" }],
]) {
  const { ctx, page } = await open({ film: film({ phase: "stopped", parts: [part(0, "done"), part(1, "pending")], ...extra }) });
  await page.waitForSelector(".films-part");
  check(`ceiling ${name}: no resume, says raise it`, !(await page.locator("#film-resume").isVisible()) && (await text(page, "#film-stop-note")).includes("Raise the ceiling"));
  await ctx.close();
}
{
  const { ctx, page } = await open({ film: film({ phase: "running", stop_code: "spend_ceiling", stop_reason: "over budget", parts: [part(0, "running"), part(1, "pending")] }) });
  await page.waitForSelector(".films-part");
  const note = await text(page, "#film-stop-note");
  check("ceiling while running: does not claim it clears", note.includes("No new parts") && !note.includes("clears by itself"), note);
  await ctx.close();
}

// ---- all films, for a device that started none, and the fallback without the route.
{
  const list = [{ film_id: "feature-1", project: "Harbor", phase: "running", stop_reason: "rate limited", stop_code: "gate_held", created_at: 1, shots_done: 3, shots_total: 90 }];
  const { ctx, page } = await open({ list }, "/films");
  await page.waitForSelector("#films-all a");
  const row = await text(page, "#films-all");
  check("home lists every film with its state", row.includes("Harbor") && row.includes("3 of 90 shots") && row.includes("rate limited"), row);
  check("the device-only list steps aside", !(await page.locator("#films-recent-wrap").isVisible()));
  check("list links to the film", (await page.locator("#films-all a").getAttribute("href")) === "films?id=feature-1");
  await ctx.close();
  const none = await open({}, "/films");
  await none.page.waitForTimeout(400);
  check("without the route the device list stands", await none.page.locator("#films-recent-wrap").isVisible());
  await none.ctx.close();
}

// ---- raising the ceiling, and a refusal.
{
  const state = { film: film({ phase: "stopped", stop_reason: "spend ceiling reached", parts: [part(0, "done"), part(1, "pending")] }) };
  const { ctx, page, seen } = await open(state);
  await page.waitForSelector(".films-part");
  state.ceilingRefuse = true;
  await page.fill("#film-ceiling-input", "501");
  await page.click('#film-ceiling button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#film-load-note")?.textContent.includes("did not change"));
  check("ceiling refusal names the reason", (await text(page, "#film-load-note")).includes("must be above"));
  state.ceilingRefuse = false;
  await page.fill("#film-ceiling-input", "900");
  await page.click('#film-ceiling button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#film-spend")?.textContent.includes("$900.00"));
  check("ceiling posts the number", seen.ceilings.at(-1)?.spend_ceiling_usd === 900, JSON.stringify(seen.ceilings));
  await ctx.close();
}

// ---- done, with a limit.
{
  const { ctx, page, seen } = await open({ film: film({ phase: "done", shots_done: 90, output_key: "renders/f/film.mp4", sidecar_key: "renders/f/film.srt", bytes: 3780000000, duration_seconds: 2700, degraded: "part 2 has no captions", parts: [part(0, "done"), part(1, "done"), part(2, "done")] }) });
  await page.waitForSelector("#film-output a");
  const out = await text(page, "#film-output");
  check("done: size and length", out.includes("45 min") && out.includes("3.78 GB"), out);
  check("done: limit is shown", (await page.locator("#film-degraded").isVisible()) && (await text(page, "#film-degraded")).includes("part 2 has no captions"));
  check("done: film download named", (await page.locator('#film-output a[download="Harbor.mp4"]').count()) === 1);
  check("done: captions offered", (await page.locator('#film-output a[download="Harbor.srt"]').count()) === 1);
  check("done: parts keep their order in the file name", (await page.locator('.films-part a[download="Harbor-part-03.mp4"]').count()) === 1);
  check("done: no film fetched until watched", seen.films.length === 0, seen.films.join());
  check("done: fits a phone", await noOverflow(page));
  await ctx.close();
}

// ---- unknown id, and the home page remembering a film.
{
  const { ctx, page } = await open({ film: null });
  await page.waitForFunction(() => document.querySelector("#film-load-note")?.textContent.includes("No film"));
  check("unknown id says so", !(await page.locator("#film-detail").isVisible()));
  await ctx.close();
  const seen = await open({ film: film() });
  await seen.page.waitForSelector(".films-part");
  await seen.page.goto(`${B}/films`);
  await seen.page.waitForSelector("#films-recent a");
  check("home lists a film opened here", (await text(seen.page, "#films-recent")).includes("Harbor"));
  await seen.ctx.close();
}

// ---- shot review and a new take.
{
  const shot = (i, extra = {}) => ({ shot_id: `s${i + 1}`, index: i, status: "done", seconds: 6, delivered_seconds: 5.9, keyframe_key: `renders/k/${i}.png`, clip_key: `renders/c/${i}.mp4`, prompt: `Prompt ${i + 1}`, line: i === 30 ? "Hello." : null, error: null, attempts: 1, retake_status: null, ...extra });
  const shots = (n) => Array.from({ length: 30 }, (_, k) => shot(n * 30 + k));
  const donefilm = film({ phase: "done", shots_done: 90, output_key: "renders/f/film.mp4", parts: [part(0, "done"), part(1, "done"), part(2, "done")] });
  const pendingRetake = film({ phase: "running", cron: { last_tick_at: 1, stale: false }, output_key: "renders/f/film.mp4", parts: [part(0, "done"), part(1, "pending", { retake_shots: ["s31"] }), part(2, "done")] });
  const state = { film: donefilm, shots, afterRetake: pendingRetake, afterCancel: donefilm };
  const { ctx, page, seen } = await open(state);
  await page.waitForSelector(".films-part");
  check("shots not read until asked", seen.shotReads.length === 0);
  await page.locator('[data-part-index="1"] button[aria-expanded]').click();
  await page.waitForSelector('[data-shot-index="30"]');
  const card = await text(page, '[data-shot-index="30"]');
  check("shot shows master number, id, seconds, prompt, line", card.includes("Shot 31") && card.includes("s31") && card.includes("5.9 s delivered of 6 s") && card.includes("Prompt 31") && card.includes("Hello."), card);
  check("no clip fetched until watched", seen.films.filter((u) => u.includes("/c/")).length === 0);
  check("stills load lazily", (await page.locator('[data-shot-index="30"] img').getAttribute("loading")) === "lazy");
  check("shots fit a phone", await noOverflow(page));
  await page.locator('[data-shot-index="30"]').getByRole("button", { name: "New take", exact: true }).click();
  await page.waitForSelector("#film-retake-dialog[open]");
  check("new take starts from the shot's text", (await page.inputValue("#film-retake-prompt")) === "Prompt 31" && (await page.inputValue("#film-retake-line")) === "Hello.");
  check("new take states what it buys", (await text(page, "#film-retake-dialog")).includes("Every other shot is kept"));
  await page.click('#film-retake-dialog button[value="cancel"]');
  await page.waitForTimeout(200);
  check("go back buys nothing", seen.retakes.length === 0);
  await page.locator('[data-shot-index="30"]').getByRole("button", { name: "New take", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#film-retake-voice")?.options.length > 1);
  await page.fill("#film-retake-line", "Goodbye.");
  await page.selectOption("#film-retake-voice", "athena");
  await page.click('#film-retake-dialog button[value="go"]');
  await page.waitForFunction(() => document.querySelector("#film-action-note")?.textContent.includes("within about a minute"));
  check("retake posts the master id and only what changed", seen.retakes[0]?.shot === "s31" && JSON.stringify(seen.retakes[0]?.body) === '{"line":"Goodbye.","voice_id":"athena"}', JSON.stringify(seen.retakes));
  check("the old film is still offered, and says so", (await page.locator("#film-retake-note").isVisible()) && (await page.locator("#film-output a").count()) > 0);
  check("part names the shot in retake", (await text(page, '[data-part-index="1"]')).includes("s31"));
  check("an open part stays open", (await page.locator('[data-part-index="1"] button[aria-expanded="true"]').count()) === 1);
  check("a pending retake still offers another", (await page.locator('[data-part-index="1"]').getByRole("button", { name: "New take", exact: true }).count()) > 0);
  await page.locator('[data-part-index="1"]').getByRole("button", { name: "Cancel the new take" }).click();
  await page.waitForSelector("#film-retry-dialog[open]");
  check("cancel states a take already run stays paid", (await text(page, "#film-retry-dialog")).includes("stays paid for"));
  await page.click('#film-retry-dialog button[value="go"]');
  await page.waitForFunction(() => !document.querySelector("#film-retake-note") || document.querySelector("#film-retake-note").hidden);
  check("cancel posts once", seen.cancels === 1);
  await ctx.close();
}
{
  // A stopped film with a waiting retake still has to be polled, or the board never sees it move.
  const { ctx, page, seen } = await open({ film: film({ phase: "stopped", parts: [part(0, "done"), part(1, "pending", { retake_shots: ["s31"] })] }) });
  await page.waitForSelector(".films-part");
  const gets = seen.gets;
  await page.waitForFunction(() => false, null, { timeout: 21000 }).catch(() => {});
  check("a waiting retake keeps polling", seen.gets > gets, `${gets} ${seen.gets}`);
  await ctx.close();
}
{
  // A new still is a separate, labelled choice.
  const shot = { shot_id: "s1", index: 0, status: "done", seconds: 6, keyframe_key: null, clip_key: null, prompt: "P", line: null, error: null, retake_status: null };
  const { ctx, page, seen } = await open({ film: film({ phase: "done", parts: [part(0, "done")], output_key: "renders/f/film.mp4" }), shots: () => [shot] });
  await page.waitForSelector(".films-part");
  await page.locator(".films-part button[aria-expanded]").click();
  await page.getByRole("button", { name: "New take", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#film-retake-voice")?.options.length > 1);
  check("new still is off by default and labelled", !(await page.locator("#film-retake-still").isChecked()) && (await text(page, "#film-retake-dialog")).includes("one shot's estimate against the ceiling"));
  await page.check("#film-retake-still");
  await page.click('#film-retake-dialog button[value="go"]');
  await page.waitForFunction(() => document.querySelector("#film-action-note")?.textContent.includes("saved"));
  check("new still is sent", seen.retakes[0]?.body?.new_still === true, JSON.stringify(seen.retakes));
  await ctx.close();
}
{
  // The promise of a minute needs a live scheduler. The server's note is shown as it came.
  const shot = { shot_id: "s1", index: 0, status: "done", seconds: 6, keyframe_key: null, clip_key: null, prompt: "P", line: null, error: null, retake_status: null };
  for (const [name, cron, promise] of [["alive", { last_tick_at: 1, stale: false }, true], ["stale", { last_tick_at: 1, stale: true }, false], ["absent", undefined, false]]) {
    const f = film({ phase: "done", cron, parts: [part(0, "done")], output_key: "renders/f/film.mp4" });
    const { ctx, page } = await open({ film: f, shots: () => [shot], afterRetake: f, retakeNote: "On a door that uses end frames, the shot before keeps its old end frame, so it is not bought again. A cut hides that. rebuy_previous: true buys it too." });
    await page.waitForSelector(".films-part");
    await page.locator(".films-part button[aria-expanded]").click();
    await page.getByRole("button", { name: "New take", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#film-retake-voice")?.options.length > 1);
    await page.click('#film-retake-dialog button[value="go"]');
    await page.waitForFunction(() => document.querySelector("#film-action-note")?.textContent.includes("saved"));
    const note = await text(page, "#film-action-note");
    check(`cron ${name}: minute promise ${promise}`, note.includes("within about a minute") === promise, note);
    check(`cron ${name}: server note shown`, note.includes("keeps its old end frame") && note.includes("A cut hides that."), note);
    check(`cron ${name}: no API wording on the page`, !note.includes("rebuy_previous"), note);
    await ctx.close();
  }
}
{
  // A failed retake waits for a person. Polling it would only hide that.
  const { ctx, page, seen } = await open({ film: film({ phase: "stopped", parts: [part(0, "failed", { retake_shots: ["s1"] }), part(1, "done")] }) });
  await page.waitForSelector(".films-part");
  const gets = seen.gets;
  await page.waitForFunction(() => false, null, { timeout: 21000 }).catch(() => {});
  check("a failed retake stops polling", seen.gets === gets, `${gets} ${seen.gets}`);
  check("a failed retake can be cancelled", (await page.getByRole("button", { name: "Cancel the new take" }).count()) === 1);
  await ctx.close();
}
{
  // A dead scheduler is said out loud, and waking asks nothing because it costs nothing.
  const { ctx, page, seen } = await open({ film: film({ cron: { last_tick_at: 1, stale: true } }) });
  await page.waitForSelector(".films-part");
  check("stale scheduler is shown", await page.locator("#film-cron").isVisible());
  check("stale offers no button that could release a hold", (await page.locator("#film-cron button").count()) === 0);
  await ctx.close();
  const ok = await open({ film: film({ cron: { last_tick_at: 1, stale: false } }) });
  await ok.page.waitForSelector(".films-part");
  check("a live scheduler shows nothing", !(await ok.page.locator("#film-cron").isVisible()));
  await ok.ctx.close();
  const done = await open({ film: film({ phase: "done", cron: { last_tick_at: 1, stale: true }, parts: [part(0, "done")] }) });
  await done.page.waitForSelector(".films-part");
  check("a finished film does not warn", !(await done.page.locator("#film-cron").isVisible()));
  await done.ctx.close();
}
{
  // Retake is only offered where the contract allows it, and a keeping prompt sends nothing.
  const shot = { shot_id: "s1", index: 0, status: "done", seconds: 6, keyframe_key: null, clip_key: null, prompt: "P", line: null, error: "clip failed", retake_status: "running" };
  const state = { film: film({ phase: "running", parts: [part(0, "running", { retake_shots: ["s1"], shots_done: 30 }), part(1, "failed"), part(2, "done")] }), shots: () => [shot] };
  const { ctx, page, seen } = await open(state);
  await page.waitForSelector(".films-part");
  await page.locator('[data-part-index="0"] button[aria-expanded]').click();
  await page.waitForSelector('[data-shot-index="0"]');
  check("no retake on a running part", (await page.locator('[data-part-index="0"]').getByRole("button", { name: "New take", exact: true }).count()) === 0);
  check("no cancel on a running retake", (await page.locator('[data-part-index="0"]').getByRole("button", { name: "Cancel the new take" }).count()) === 0);
  check("optional fields absent are fine", !(await text(page, '[data-shot-index="0"]')).includes("undefined") && (await text(page, '[data-shot-index="0"]')).includes("clip failed"));
  check("retake status shown", (await text(page, '[data-shot-index="0"]')).includes("New take in progress"));
  check("all shots done reads as not stuck", (await text(page, '[data-part-index="0"]')).includes("moves on within about a minute"));
  await page.locator('[data-part-index="1"] button[aria-expanded]').click();
  await page.waitForTimeout(300);
  check("no retake on a failed part", (await page.locator('[data-part-index="1"]').getByRole("button", { name: "New take", exact: true }).count()) === 0);
  check("seen no retake posts", seen.retakes.length === 0);
  await ctx.close();
}
{
  // Refused retake, unread shots, go to shot.
  const shots = (n) => [{ shot_id: `s${n * 30 + 1}`, index: n * 30 + 12, status: "done", seconds: 6, keyframe_key: null, clip_key: null, prompt: "P", line: null, error: null, retake_status: null }];
  const state = { film: film({ phase: "done", parts: [part(0, "done"), part(1, "done"), part(2, "done")], output_key: "renders/f/film.mp4" }), shots, retakeRefuse: "the part is not finished" };
  const { ctx, page, seen } = await open(state);
  await page.waitForSelector(".films-part");
  await page.fill("#film-find-number", "43");
  await page.click('#film-find button[type="submit"]');
  await page.waitForSelector('[data-shot-index="42"]');
  check("go to shot opens the right part", seen.shotReads.join() === "1", seen.shotReads.join());
  await page.waitForTimeout(700);
  check("go to shot marks it", (await page.locator(".films-shot-found").count()) === 1);
  await page.fill("#film-find-number", "999");
  await page.click('#film-find button[type="submit"]');
  check("an unknown shot says so", (await text(page, "#film-action-note")).includes("No shot 999"));
  await page.locator('[data-shot-index="42"]').getByRole("button", { name: "New take", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#film-retake-voice")?.options.length > 0);
  await page.click('#film-retake-dialog button[value="go"]');
  await page.waitForFunction(() => document.querySelector("#film-load-note")?.textContent.includes("did not change"));
  check("a refused retake shows why", (await text(page, "#film-load-note")).includes("the part is not finished"));
  check("no prompt change sends an empty body", JSON.stringify(seen.retakes[0]?.body) === "{}", JSON.stringify(seen.retakes));
  await ctx.close();
  const none = await open({ film: film({ parts: [part(0, "done")] }) });
  await none.page.waitForSelector(".films-part");
  await none.page.locator(".films-part button[aria-expanded]").click();
  await none.page.waitForFunction(() => document.querySelector(".films-shots")?.textContent.includes("Could not load"));
  check("unread shots say so", true);
  await none.ctx.close();
}

// ---- no lookbehind: older Safari cannot parse one, and a parse error stops the whole script.
{
  const { readdir } = await import("node:fs/promises");
  const scripts = (await readdir(ROOT)).filter((f) => f.endsWith(".js"));
  const found = [];
  for (const f of scripts) if (/\(\?<[=!]/.test(await readFile(join(ROOT, f), "utf8"))) found.push(f);
  check(`no regex lookbehind in ${scripts.length} page scripts`, scripts.length > 5 && found.length === 0, found.join());
}

// ---- hiding the sheet before the shots answer.
{
  let release;
  const shot = { shot_id: "s1", index: 0, status: "done", seconds: 6, keyframe_key: "renders/k/held.png", clip_key: null, prompt: "P", line: null, error: null, retake_status: null };
  const state = { film: film({ phase: "done", parts: [part(0, "done")] }), shots: () => [shot], holdShots: new Promise((r) => { release = r; }) };
  const { ctx, page } = await open(state);
  const stills = [];
  page.on("request", (r) => { if (r.url().includes("held.png")) stills.push(r.url()); });
  await page.waitForSelector(".films-part");
  await page.locator(".films-sheet-toggle").click();
  await page.waitForTimeout(100);
  await page.locator(".films-sheet-toggle").click();
  release();
  await page.waitForTimeout(500);
  check("hidden before the answer: no tiles", (await page.locator(".films-sheet-tile").count()) === 0);
  check("hidden before the answer: no stills fetched", stills.length === 0, stills.join());
  await ctx.close();
}

// ---- an open sheet survives polls, and reloads when the part changes stage.
{
  const shot = { shot_id: "s1", index: 0, status: "done", seconds: 6, keyframe_key: "renders/k/0.png", clip_key: null, prompt: "P", line: null, error: null, retake_status: null };
  const state = { film: film({ parts: [part(0, "running", { shots_done: 1 })] }), shots: () => [shot] };
  const { ctx, page, seen } = await open(state);
  await page.waitForSelector(".films-part");
  await page.locator(".films-sheet-toggle").click();
  await page.waitForSelector(".films-sheet-tile");
  await page.evaluate(() => { window.__tile = document.querySelector(".films-sheet-tile"); });
  state.film = film({ parts: [part(0, "running", { shots_done: 2 })] });
  const gets = seen.gets;
  await page.waitForFunction(() => /2 of 30 shots/.test(document.querySelector(".films-part")?.textContent ?? ""), null, { timeout: 25000 });
  check("a poll changed the part", seen.gets > gets);
  check("a poll does not reread the sheet", seen.shotReads.length === 1, seen.shotReads.join());
  check("a poll keeps the tiles", await page.evaluate(() => window.__tile.isConnected));
  check("toggle stays right after a rebuild", (await text(page, ".films-sheet-toggle")) === "Hide contact sheet");
  state.film = film({ parts: [part(0, "done", { shots_done: 30 })] });
  await page.waitForFunction(() => /Done/.test(document.querySelector(".films-part")?.textContent ?? ""), null, { timeout: 25000 });
  await page.waitForTimeout(300);
  check("a new stage rereads the sheet", seen.shotReads.length === 2, seen.shotReads.join());
  check("the sheet stays filled", (await page.locator(".films-sheet-tile").count()) === 1);
  await ctx.close();
}

// ---- the viewer follows the part, not the snapshot it opened from.
{
  const shot = { shot_id: "s1", index: 0, status: "done", seconds: 6, keyframe_key: "renders/k/0.png", clip_key: null, prompt: "P", line: null, error: null, retake_status: null };
  const state = { film: film({ parts: [part(0, "done"), part(1, "running")] }), shots: () => [shot] };
  const { ctx, page } = await open(state);
  await page.waitForSelector(".films-part");
  await page.locator('[data-part-index="0"] .films-sheet-toggle').click();
  await page.locator('[data-part-index="0"] .films-sheet-tile').click();
  await page.waitForSelector("#film-still-dialog[open]");
  check("viewer offers a take on a done part", await page.locator("#film-still-retake").isVisible());
  state.film = film({ parts: [part(0, "running"), part(1, "running")] });
  const gone = await page.waitForFunction(() => document.querySelector("#film-still-retake").hidden, null, { timeout: 25000 }).then(() => true, () => false);
  check("viewer drops the take when the part starts running", gone);
  await ctx.close();
}

// ---- thumbnails: small on the sheet, full in the viewer, one fallback, no loop.
{
  const shot = { shot_id: "s1", index: 0, status: "done", seconds: 6, keyframe_key: "renders/k/a b.png", clip_key: null, prompt: "P", line: null, error: null, retake_status: null };
  const none = { ...shot, shot_id: "s2", index: 1, keyframe_key: null };
  const state = { artifactOk: true, film: film({ phase: "done", parts: [part(0, "done")] }), shots: () => [shot, none] };
  const { ctx, page, seen } = await open(state);
  await page.waitForSelector(".films-part");
  await page.locator(".films-sheet-toggle").click();
  await page.waitForSelector(".films-sheet-tile img");
  await page.waitForTimeout(300);
  check("sheet asks for the thumb, encoded like an artifact", seen.thumbs.join() === "/api/thumb/renders/k/a%20b.png", seen.thumbs.join());
  check("sheet does not fetch the full still", seen.artifacts.length === 0, seen.artifacts.join());
  check("a shot with no still asks for nothing", seen.thumbs.length === 1 && (await page.locator(".films-sheet-empty").count()) === 1);
  await page.locator(".films-sheet-tile").first().click();
  await page.waitForSelector("#film-still-dialog[open]");
  await page.waitForTimeout(300);
  check("viewer shows the full still", seen.artifacts.join() === "/api/artifact/renders/k/a%20b.png", seen.artifacts.join());
  await ctx.close();
  const down = await open({ thumbDown: true, film: film({ phase: "done", parts: [part(0, "done")] }), shots: () => [shot] });
  await down.page.waitForSelector(".films-part");
  await down.page.locator(".films-sheet-toggle").click();
  await down.page.waitForSelector(".films-sheet-tile img");
  await down.page.waitForTimeout(600);
  check("a failed thumb falls back to the full still once", down.seen.artifacts.length === 1 && down.seen.thumbs.length === 1, `${down.seen.thumbs.length} ${down.seen.artifacts.length}`);
  check("a failed full still does not loop", await down.page.evaluate(() => document.querySelector(".films-sheet-tile img").onerror === null));
  await down.ctx.close();
}

// ---- the contact sheet.
{
  const shot = (i, extra = {}) => ({ shot_id: `s${i + 1}`, index: i, status: "done", seconds: 6, keyframe_key: `renders/k/${i}.png`, clip_key: null, prompt: `Prompt ${i + 1}`, line: null, error: null, retake_status: null, ...extra });
  const state = { film: film({ phase: "done", output_key: "renders/f/film.mp4", sidecar_key: "renders/f/film.srt", parts: [part(0, "done"), part(1, "done"), part(2, "pending")] }), shots: (n) => [shot(n * 30), shot(n * 30 + 1, { keyframe_key: null }), shot(n * 30 + 2)] };
  const { ctx, page, seen } = await open(state);
  await page.waitForSelector(".films-part");
  check("sheet not read until asked", seen.shotReads.length === 0);
  const whole = page.locator('#film-output a[download="Harbor.mp4"]');
  check("whole film download points at the film", (await whole.getAttribute("href")) === "/api/artifact/renders/f/film.mp4");
  check("captions download points at the sidecar", (await page.locator('#film-output a[download="Harbor.srt"]').getAttribute("href")) === "/api/artifact/renders/f/film.srt");
  await page.locator('[data-part-index="1"] .films-sheet-toggle').click();
  await page.waitForSelector('[data-part-index="1"] .films-sheet-tile');
  check("sheet reads the right part", seen.shotReads.join() === "1", seen.shotReads.join());
  check("a tile per shot", (await page.locator('[data-part-index="1"] .films-sheet-tile').count()) === 3);
  check("tiles show master numbers", (await text(page, '[data-part-index="1"] .films-sheet-grid')).includes("31"));
  check("a missing still is said", (await text(page, '[data-part-index="1"] .films-sheet')).includes("1 of 3 shots have no still"));
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector(".films-sheet-grid")).gridTemplateColumns.split(" ").length);
  check("at least three across on a phone", cols >= 3, String(cols));
  check("sheet fits a phone", await noOverflow(page));
  await page.locator('[data-part-index="1"] .films-sheet-tile').first().click();
  await page.waitForSelector("#film-still-dialog[open]");
  check("tap opens it large with its number", (await text(page, "#film-still-title")).includes("Shot 31") && (await page.getAttribute("#film-still-img", "src")).endsWith("/30.png"));
  check("first has no previous", await page.locator("#film-still-prev").isDisabled());
  await page.click("#film-still-next");
  check("next moves on", (await text(page, "#film-still-title")).includes("Shot 32"));
  check("a shot with no still shows no image", !(await page.locator("#film-still-img").isVisible()));
  await page.click("#film-still-next");
  check("last has no next", await page.locator("#film-still-next").isDisabled());
  check("still fits a phone", await page.evaluate(() => { const r = document.querySelector("#film-still-dialog").getBoundingClientRect(); return r.right <= innerWidth && r.left >= 0; }));
  await page.click("#film-still-retake");
  await page.waitForSelector("#film-retake-dialog[open]");
  check("new take from the sheet is for that shot", (await text(page, "#film-retake-title")).includes("shot 33") && (await page.inputValue("#film-retake-prompt")) === "Prompt 33");
  await page.click('#film-retake-dialog button[value="cancel"]');
  await page.locator('[data-part-index="2"] .films-sheet-toggle').click();
  await page.waitForSelector('[data-part-index="2"] .films-sheet-tile');
  await page.locator('[data-part-index="2"] .films-sheet-tile').first().click();
  check("no new take where the part does not allow it", !(await page.locator("#film-still-retake").isVisible()));
  await page.click("#film-still-close");
  await page.locator('[data-part-index="1"] .films-sheet-toggle').click();
  check("hide clears the sheet", (await page.locator('[data-part-index="1"] .films-sheet-tile').count()) === 0);
  await ctx.close();
  const none = await open({ film: film({ parts: [part(0, "done")] }) });
  await none.page.waitForSelector(".films-part");
  await none.page.locator(".films-sheet-toggle").click();
  await none.page.waitForFunction(() => document.querySelector(".films-sheet")?.textContent.includes("Could not load"));
  check("sheet says when it cannot load", true);
  await none.ctx.close();
}

await browser.close();
server.close();
console.log(bad ? `${bad} failed` : "all passed");
process.exit(bad ? 1 : 0);
