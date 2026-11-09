// cf#784: a finish job lost to a container restart is DETECTABLE, not read as a job that never existed.
//
// Job state is the container's process memory (containers/video-finish/app.py JOBS), so a restart drops
// a running job and the next status read answers 404 not_found, the same 404 as an unknown job. The
// container now names its process on every async body (`instance`), and the Durable Object compares
// the instance that took the 202 with the one that answered the 404.
//
// What this does NOT do, stated so it is not read as more: it does not keep the job alive across a
// restart, and it does not change core's reading of the 404 (still `missing`, still debounced by the
// not-found streak, then re-submitted under the deterministic output key). It makes the loss visible.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FinishContainer } from "../src/finish-container";
import { FinishJobTail, JOB_LOST_REASON, RUNNING_SLEEP_AFTER, lostToRestart, observeExchange } from "../src/finish-job-tail";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const ORIGIN = "http://video-finish";
const submit = () => new Request(ORIGIN + "/async/finish", { method: "POST", body: "{}" });
const status = (id: string) => new Request(ORIGIN + "/async/status/" + id);

function container(answers: Response[]) {
  const c = Object.create(FinishContainer.prototype) as FinishContainer & Record<string, unknown>;
  Object.assign(c, {
    defaultPort: 8000,
    sleepAfter: RUNNING_SLEEP_AFTER,
    sleepAfterMs: 0,
    jobTail: new FinishJobTail(),
    env: { MEDIA_FINISH_TOKEN: "lost-test-token" },
    containerFetch: async () => answers.shift() as Response,
  });
  return c;
}

function warnings(): string[] {
  const out: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "log").mockImplementation(() => {});
  return out;
}
afterEach(() => vi.restoreAllMocks());

describe("cf#784: lostToRestart", () => {
  async function tailWith(jobId: string, instance?: string) {
    const t = new FinishJobTail();
    await observeExchange(t, "POST", "/async/finish", json({ ok: true, jobId, status: "pending", ...(instance ? { instance } : {}) }, 202));
    return t;
  }

  it("the submit's instance is recorded", async () => {
    expect((await tailWith("j1", "boot-A")).acceptedBy("j1")).toBe("boot-A");
  });

  it("not_found from a DIFFERENT instance is a lost job", async () => {
    const t = await tailWith("j1", "boot-A");
    const lost = await lostToRestart(t, "GET", "/async/status/j1", json({ ok: true, status: "not_found", instance: "boot-B" }, 404));
    expect(lost).toEqual({ jobId: "j1", acceptedBy: "boot-A", answeredBy: "boot-B" });
  });

  it.each([
    ["same instance answers (never existed, or reaped)", "boot-A", { ok: true, status: "not_found", instance: "boot-A" }, 404],
    ["old container sends no instance", "boot-A", { ok: true, status: "not_found" }, 404],
    ["no recorded submit (evicted object, or pre-change submit)", undefined, { ok: true, status: "not_found", instance: "boot-B" }, 404],
    ["a pending status is not a loss", "boot-A", { ok: true, status: "pending", instance: "boot-B" }, 200],
  ])("claims nothing when %s", async (_l, accepted, body, code) => {
    const t = await tailWith("j1", accepted as string | undefined);
    expect(await lostToRestart(t, "GET", "/async/status/j1", json(body, code as number))).toBeNull();
  });
});

describe("cf#784: through the real FinishContainer.fetch", () => {
  it("a restart between submit and poll is logged and marked, and the 404 stays a 404", async () => {
    const log = warnings();
    const c = container([
      json({ ok: true, jobId: "j9", status: "pending", instance: "boot-A" }, 202),
      json({ ok: true, status: "not_found", instance: "boot-B" }, 404),
    ]);
    await c.fetch(submit());
    const r = await c.fetch(status("j9"));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ ok: true, status: "not_found", instance: "boot-B", lost: JOB_LOST_REASON });
    const ev = log.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.ev === "finish_container.job_lost");
    expect(ev).toMatchObject({ job_id: "j9", accepted_by: "boot-A", answered_by: "boot-B" });
    // The lost job is no longer tracked as open.
    expect((c as unknown as { jobTail: FinishJobTail }).jobTail.acceptedBy("j9")).toBeUndefined();
  });

  it("CONTROL: an unknown job on the same instance passes through untouched and logs nothing", async () => {
    const log = warnings();
    const c = container([
      json({ ok: true, jobId: "j9", status: "pending", instance: "boot-A" }, 202),
      json({ ok: true, status: "not_found", instance: "boot-A" }, 404),
    ]);
    await c.fetch(submit());
    const r = await c.fetch(status("other"));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ ok: true, status: "not_found", instance: "boot-A" });
    expect(log.some((l) => l.includes("finish_container.job_lost"))).toBe(false);
  });
});

describe("cf#784: the field this reads is the field the container writes", () => {
  // Binds the two languages: containers/video-finish/test_instance_id.py proves the behaviour in Python,
  // and these name the exact bodies, so a rename on one side cannot leave the other reading nothing.
  const app = readFileSync(join(import.meta.dirname, "..", "containers/video-finish/app.py"), "utf8");
  it.each([
    '{"ok": True, "jobId": job_id, "status": "pending", "instance": INSTANCE_ID}, status=202',
    '{"ok": True, "status": "not_found", "instance": INSTANCE_ID}, status=404',
  ])("app.py answers %s", (line) => {
    expect(app).toContain(line);
  });
  it("INSTANCE_ID is minted once per process", () => {
    expect(app).toMatch(/^INSTANCE_ID = uuid\.uuid4\(\)\.hex$/m);
  });
});
