import { describe, expect, it } from "vitest";
import { FinishContainer } from "../src/finish-container";
import { FinishJobTail, RELEASE_SLEEP_AFTER, RUNNING_SLEEP_AFTER, observeExchange } from "../src/finish-job-tail";

// cf#1064. The hard requirement: the timer must never shorten while a job can still be running, because
// polls are the only thing keeping a running encode awake. A stub cannot prove the platform frees a slot:
// that needs the live reading in the PR.

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const ORIGIN = "http://video-finish";

/** The real FinishContainer.fetch and the real base Container.fetch, over a fake containerFetch. */
function container(answers: Response[]) {
  const c = Object.create(FinishContainer.prototype) as FinishContainer & Record<string, unknown>;
  Object.assign(c, {
    defaultPort: 8000,
    sleepAfter: RUNNING_SLEEP_AFTER,
    sleepAfterMs: 0,
    jobTail: new FinishJobTail(),
    containerFetch: async () => answers.shift() as Response,
  });
  return c;
}
const submit = () => new Request(ORIGIN + "/async/finish", { method: "POST", body: "{}" });
const status = (id: string) => new Request(ORIGIN + "/async/status/" + id);

describe("FinishContainer idle tail", () => {
  it("defaults to the long timer", () => {
    expect(RUNNING_SLEEP_AFTER).toBe("10m");
    expect(RELEASE_SLEEP_AFTER).toBe("5m");
  });

  it("stays long while the job is pending, and shortens on completed", async () => {
    const c = container([json({ ok: true, jobId: "a" }, 202), json({ status: "pending" }), json({ status: "completed", result: {} })]);
    await c.fetch(submit());
    expect(c.sleepAfter).toBe(RUNNING_SLEEP_AFTER);
    await c.fetch(status("a"));
    expect(c.sleepAfter).toBe(RUNNING_SLEEP_AFTER);
    const before = Date.now();
    await c.fetch(status("a"));
    expect(c.sleepAfter).toBe(RELEASE_SLEEP_AFTER);
    const ms = (c as unknown as { sleepAfterMs: number }).sleepAfterMs;
    expect(ms - before).toBeGreaterThan(4 * 60_000);
    expect(ms - before).toBeLessThan(6 * 60_000);
  });

  it("shortens on failed too", async () => {
    const c = container([json({ ok: true, jobId: "a" }, 202), json({ status: "failed", error: "x" })]);
    await c.fetch(submit());
    await c.fetch(status("a"));
    expect(c.sleepAfter).toBe(RELEASE_SLEEP_AFTER);
  });

  it("does not shorten while a second job is still open", async () => {
    const c = container([json({ ok: true, jobId: "a" }, 202), json({ ok: true, jobId: "b" }, 202), json({ status: "completed" }), json({ status: "completed" })]);
    await c.fetch(submit());
    await c.fetch(submit());
    await c.fetch(status("a"));
    expect(c.sleepAfter).toBe(RUNNING_SLEEP_AFTER);
    await c.fetch(status("b"));
    expect(c.sleepAfter).toBe(RELEASE_SLEEP_AFTER);
  });

  it("goes long again when the mux leg submits on the same instance", async () => {
    const c = container([json({ ok: true, jobId: "a" }, 202), json({ status: "completed" }), json({ ok: true, jobId: "b" }, 202)]);
    await c.fetch(submit());
    await c.fetch(status("a"));
    expect(c.sleepAfter).toBe(RELEASE_SLEEP_AFTER);
    await c.fetch(submit());
    expect(c.sleepAfter).toBe(RUNNING_SLEEP_AFTER);
  });

  it("a re-poll of the finished job still reaches the container and returns its body", async () => {
    const c = container([json({ ok: true, jobId: "a" }, 202), json({ status: "completed" }), json({ status: "completed", result: { ok: true } })]);
    await c.fetch(submit());
    await c.fetch(status("a"));
    const again = await c.fetch(status("a"));
    expect(((await again.json()) as { result: { ok: boolean } }).result.ok).toBe(true);
  });

  it("the caller can still read a response the tail already read", async () => {
    const c = container([json({ ok: true, jobId: "a" }, 202)]);
    expect(((await (await c.fetch(submit())).json()) as { jobId: string }).jobId).toBe("a");
  });

  it("a refused submit or a stateless route changes nothing", async () => {
    const c = container([new Response("no", { status: 500 }), json({ status: "completed" })]);
    await c.fetch(submit());
    await c.fetch(new Request(ORIGIN + "/inspect", { method: "POST", body: "{}" }));
    expect(c.sleepAfter).toBe(RUNNING_SLEEP_AFTER);
  });
});

describe("observeExchange", () => {
  it("leaves the timer alone on an unreadable body", async () => {
    const d = await observeExchange(new FinishJobTail(), "GET", "/async/status/a", new Response("not json"));
    expect(d).toBeNull();
  });

  it("does not treat a 404 status as terminal", async () => {
    const d = await observeExchange(new FinishJobTail(), "GET", "/async/status/a", json({ status: "not_found" }, 404));
    expect(d).toBeNull();
  });

  it("does not trust a failed status carried by an HTTP error", async () => {
    const d = await observeExchange(new FinishJobTail(), "GET", "/async/status/a", json({ status: "failed" }, 500));
    expect(d).toBeNull();
  });
});
