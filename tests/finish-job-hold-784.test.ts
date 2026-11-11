import { describe, expect, it, vi } from "vitest";
import { FinishContainer, bearerMatches } from "../src/finish-container";
import { FinishJobTail, RELEASE_SLEEP_AFTER, RUNNING_SLEEP_AFTER } from "../src/finish-job-tail";
import {
  FINISH_JOB_HOLD_MAX_MS,
  FINISH_JOB_RECORD_TTL_MS,
  FinishJobRecords,
  expiryVerdict,
  type ProbeStatus,
  type RecordStorage,
} from "../src/finish-job-record";

// cf#784, from the Durable Object: (1) a running job keeps its instance awake when the idle timer runs
// out; (2) a finished job's answer is recorded and survives the container. These drive the real
// FinishContainer methods over a fake container and a Map-backed storage. A stub cannot prove the
// platform keeps the instance: the live long-assemble proof is deferred (hosted plus spend).

const TOKEN = "hold-test-token";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const ORIGIN = "http://video-finish";

function memStorage(): RecordStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T,>(k: string) => map.get(k) as T | undefined,
    put: async <T,>(k: string, v: T) => void map.set(k, v),
    delete: async (k: string) => map.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) =>
      new Map([...map].filter(([k]) => k.startsWith(prefix))) as Map<string, T>,
  };
}

function container(answers: Response[], storage = memStorage()) {
  const c = Object.create(FinishContainer.prototype) as FinishContainer & Record<string, unknown>;
  const calls: Request[] = [];
  const stop = vi.fn(async () => {});
  Object.assign(c, {
    defaultPort: 8000,
    sleepAfter: RUNNING_SLEEP_AFTER,
    sleepAfterMs: 0,
    jobTail: new FinishJobTail(),
    env: { MEDIA_FINISH_TOKEN: TOKEN },
    envVars: { LOCAL_FINISH_TOKEN: TOKEN },
    ctx: { storage },
    container: { running: true },
    stop,
    containerFetch: async (r: Request) => {
      calls.push(r);
      return answers.shift() as Response;
    },
  });
  return { c, calls, stop, storage };
}
const authed = (path: string, init: RequestInit = {}) =>
  new Request(ORIGIN + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });

describe("expiryVerdict (pure)", () => {
  const tailWith = (id: string, openedAt: number) => {
    const t = new FinishJobTail();
    t.submitted(id, "i1", openedAt);
    return t;
  };
  const NOW = 10_000_000;
  for (const [status, want] of [["pending", "hold"], ["unknown", "hold"], ["terminal", "release"], ["not_found", "release"]] as [ProbeStatus, string][]) {
    it(`${status} -> ${want}`, () => {
      expect(expiryVerdict(tailWith("a", NOW - 1000), new Map([["a", status]]), NOW)).toBe(want);
    });
  }
  it("not_found marks the job lost on the tail", () => {
    const t = tailWith("a", NOW - 1000);
    expiryVerdict(t, new Map([["a", "not_found"]]), NOW);
    expect(t.openJobs()).toEqual([]);
  });
  it("a pending job past the hold cap no longer holds", () => {
    expect(expiryVerdict(tailWith("a", NOW - FINISH_JOB_HOLD_MAX_MS - 1), new Map([["a", "pending"]]), NOW)).toBe("release");
    expect(FINISH_JOB_HOLD_MAX_MS).toBe(90 * 60 * 1000);
  });
  it("one pending job among terminal ones holds", () => {
    const t = tailWith("a", NOW - 1000);
    t.submitted("b", "i1", NOW - 1000);
    expect(expiryVerdict(t, new Map<string, ProbeStatus>([["a", "terminal"], ["b", "pending"]]), NOW)).toBe("hold");
  });
});

describe("FinishJobRecords", () => {
  it("records a terminal body, ignores a pending one", async () => {
    const r = new FinishJobRecords(memStorage());
    expect(await r.recordBody("a", { status: "pending" })).toBe(false);
    expect(await r.get("a")).toBeUndefined();
    expect(await r.recordBody("a", { status: "completed", result: { key: "k" } }, 100)).toBe(true);
    expect(await r.get("a", 200)).toEqual({ status: "completed", result: { key: "k" }, at: 100 });
    await r.recordBody("b", { status: "failed", error: "boom" }, 100);
    expect((await r.get("b", 200))?.error).toBe("boom");
  });
  it("an expired record is gone, and a write prunes expired ones", async () => {
    const s = memStorage();
    const r = new FinishJobRecords(s);
    await r.recordBody("old", { status: "completed" }, 0);
    expect(await r.get("old", FINISH_JOB_RECORD_TTL_MS + 1)).toBeUndefined();
    await r.recordBody("old2", { status: "completed" }, 0);
    await r.recordBody("new", { status: "completed" }, FINISH_JOB_RECORD_TTL_MS + 1);
    expect([...s.map.keys()]).toEqual(["finish-job:new"]);
  });
});

describe("onActivityExpired holds a running job awake", () => {
  it("a pending job: probes with the bearer and does NOT stop", async () => {
    const { c, calls, stop } = container([json({ ok: true, jobId: "a", instance: "i1" }, 202), json({ status: "pending" })]);
    await c.fetch(authed("/async/finish", { method: "POST", body: "{}" }));
    await c.onActivityExpired();
    expect(stop).not.toHaveBeenCalled();
    expect(new URL(calls[1].url).pathname).toBe("/async/status/a");
    expect(calls[1].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });
  it("a finished job: records its result, then stops", async () => {
    const { c, stop, storage } = container([json({ ok: true, jobId: "a", instance: "i1" }, 202), json({ status: "completed", result: { out: 1 } })]);
    await c.fetch(authed("/async/finish", { method: "POST", body: "{}" }));
    await c.onActivityExpired();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(storage.map.get("finish-job:a")).toMatchObject({ status: "completed", result: { out: 1 } });
  });
  it("a probe that throws holds (cannot tell), bounded by the cap", async () => {
    const { c, stop } = container([json({ ok: true, jobId: "a", instance: "i1" }, 202)]);
    await c.fetch(authed("/async/finish", { method: "POST", body: "{}" }));
    (c as unknown as { containerFetch: () => Promise<Response> }).containerFetch = async () => { throw new Error("down"); };
    await c.onActivityExpired();
    expect(stop).not.toHaveBeenCalled();
  });
  it("CONTROL: with no open job it stops, as the base class does", async () => {
    const { c, stop, calls } = container([]);
    await c.onActivityExpired();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});

describe("a recorded answer survives the container", () => {
  it("a completed status read is recorded; after a restart the next read is answered from it, without the container", async () => {
    const { c, calls } = container([
      json({ ok: true, jobId: "a", instance: "i1" }, 202),
      json({ ok: true, status: "completed", result: { out: 2 }, instance: "i1" }),
    ]);
    await c.fetch(authed("/async/finish", { method: "POST", body: "{}" }));
    await c.fetch(authed("/async/status/a"));
    const before = calls.length;
    const res = await c.fetch(authed("/async/status/a"));
    expect(calls.length).toBe(before); // the container was not reached
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "completed", result: { out: 2 }, recorded: true });
  });
  it("a recorded failure answers as failed", async () => {
    const { c } = container([json({ ok: true, status: "failed", error: "ffmpeg died" })]);
    await c.fetch(authed("/async/status/a"));
    const res = await c.fetch(authed("/async/status/a"));
    expect(await res.json()).toEqual({ ok: true, status: "failed", error: "ffmpeg died", recorded: true });
  });
  it("a request without the bearer is NOT answered from the record; it goes to the container", async () => {
    const { c, calls } = container([json({ ok: true, status: "completed", result: {} }), json({ ok: false, error: "unauthorized" }, 401)]);
    await c.fetch(authed("/async/status/a"));
    const res = await c.fetch(new Request(ORIGIN + "/async/status/a", { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(2);
  });
  it("answering from the record releases the instance when it was the last open job", async () => {
    const { c } = container([json({ ok: true, jobId: "a", instance: "i1" }, 202), json({ status: "pending" })]);
    await c.fetch(authed("/async/finish", { method: "POST", body: "{}" }));
    await c.fetch(authed("/async/status/a"));
    await (c as unknown as { jobRecords: FinishJobRecords }).jobRecords.recordBody("a", { status: "completed", result: {} });
    expect(c.sleepAfter).toBe(RUNNING_SLEEP_AFTER);
    await c.fetch(authed("/async/status/a"));
    expect(c.sleepAfter).toBe(RELEASE_SLEEP_AFTER);
  });
});

describe("bearerMatches", () => {
  const r = (h?: string) => new Request(ORIGIN + "/x", { headers: h ? { authorization: h } : {} });
  it("exactly Bearer <token>", () => {
    expect(bearerMatches(r(`Bearer ${TOKEN}`), TOKEN)).toBe(true);
    for (const h of [undefined, "Bearer", `Bearer ${TOKEN}x`, `bearer ${TOKEN}`, TOKEN, `Bearer ${TOKEN.slice(1)}`]) {
      expect(bearerMatches(r(h), TOKEN)).toBe(false);
    }
    expect(bearerMatches(r(`Bearer ${TOKEN}`), undefined)).toBe(false);
  });
});
