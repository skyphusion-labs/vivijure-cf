// The film board in real Chrome at phone width. Serves public/ as files and stubs /api/*.
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
  const seen = { retries: [], films: [], gets: 0, errors: [], resumes: 0, ceilings: [] };
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
    if (pathname.startsWith("/api/artifact/")) return r.fulfill({ status: 404, body: "" });
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
  await page.waitForFunction(() => false, null, { timeout: 17000 }).catch(() => {});
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
  await page.waitForFunction(() => false, null, { timeout: 17000 }).catch(() => {});
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
  await page.waitForFunction(() => false, null, { timeout: 17000 }).catch(() => {});
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

await browser.close();
server.close();
console.log(bad ? `${bad} failed` : "all passed");
process.exit(bad ? 1 : 0);
