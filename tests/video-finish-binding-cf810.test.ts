import { describe, it, expect } from "vitest";
import {
  videoFinishDoor,
  statusInstanceName,
  productionDoorDeps,
  SYNC_POOL_SIZE,
  COMPOUND_SEPARATOR,
  type VideoFinishDoorDeps,
} from "../src/video-finish-binding";

// cf#810: the video-finish door over the FINISH_CONTAINER Durable Object binding.
//
// THE LOAD-BEARING ASSERTION IS AFFINITY, and it is the same one tests/finish-door-pool-cf507.test.ts
// makes for the GPU doors, for the same reason: job state is per-instance RAM (`JOBS` in app.py), and
// a poll that lands on the wrong instance gets a 404, which core reads as TERMINAL "job gone" rather
// than "wrong box". So a running job is reported as finished-and-vanished while a container is still
// burning CPU on it. Affinity is therefore tested as a CROSS-INSTANCE REFUSAL -- a job minted on
// instance A must never resolve to instance B -- not merely as "a poll works".
//
// Each guard below is watched producing its NEGATIVE. A routing table that has only ever been seen
// agreeing with itself is not known to route.

/** Records which DO instance NAME every call was addressed to. That name is the whole subject of
 *  these tests: it is what decides whether the poll reaches the encode. */
function fakeNamespace(handler: (name: string, url: string, init: RequestInit) => Response) {
  const calls: Array<{ name: string; url: string; method: string }> = [];
  const ns = {
    idFromName: (name: string) => ({ __name: name }),
    get: (id: { __name: string }) => ({
      fetch: async (url: string, init: RequestInit = {}) => {
        calls.push({ name: id.__name, url, method: (init.method as string) ?? "GET" });
        return handler(id.__name, url, init);
      },
    }),
  };
  return { ns: ns as never, calls };
}

function accepts(containerJobId: string) {
  return () =>
    new Response(JSON.stringify({ ok: true, jobId: containerJobId, status: "pending" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
}

const fixedDeps = (rk: string, idx = 0): VideoFinishDoorDeps => ({
  routingKey: () => rk,
  poolIndex: () => idx,
});

// A real container job id: uuid4().hex, 32 hex characters, no dot. The compound scheme depends on
// this shape, so the fixture uses the real one rather than a convenient short string.
const CJID = "9f2c1ab4d3e5470891bc6d2f7a8e0341";
const RK = "0123456789abcdef0123456789abcdef";

describe("cf#810 video-finish door: submit", () => {
  it("routes a submit to a fresh instance and rewrites the job id to a routable compound", async () => {
    const { ns, calls } = fakeNamespace(accepts(CJID));
    const door = videoFinishDoor(ns, fixedDeps(RK));

    const resp = await door.fetch("/async/finish", { method: "POST", body: "{}" });
    const body = (await resp.json()) as { ok: boolean; jobId: string; status: string };

    expect(resp.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe(RK);
    expect(calls[0].url).toBe("http://video-finish/async/finish");
    // The compound, not the container's bare id. Handing core the bare id is the defect: it carries
    // no routing key, so the poll cannot find the instance that holds the job.
    expect(body.jobId).toBe(RK + COMPOUND_SEPARATOR + CJID);
    expect(body.jobId).not.toBe(CJID);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("pending");
  });

  it("passes a non-202 through untouched rather than inventing a job id", async () => {
    const { ns } = fakeNamespace(() => new Response(JSON.stringify({ ok: false, error: "boom" }), { status: 500 }));
    const door = videoFinishDoor(ns, fixedDeps(RK));

    const resp = await door.fetch("/async/finish", { method: "POST", body: "{}" });
    const body = (await resp.json()) as { ok: boolean; error: string };

    expect(resp.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "boom" });
    expect(JSON.stringify(body)).not.toContain(RK);
  });

  it("passes a 202 with no job id through untouched, so a failed submit stays a failed submit", async () => {
    const { ns } = fakeNamespace(
      () => new Response(JSON.stringify({ ok: true, status: "pending" }), { status: 202 }),
    );
    const door = videoFinishDoor(ns, fixedDeps(RK));

    const resp = await door.fetch("/async/finish", { method: "POST", body: "{}" });
    const body = (await resp.json()) as { jobId?: string };

    // No id to make routable. Manufacturing one would produce a compound that addresses an instance
    // holding nothing, and core would poll it until the not-found streak gave up.
    expect(body.jobId).toBeUndefined();
  });
});

describe("cf#810 video-finish door: poll affinity", () => {
  it("routes a poll back to the SAME instance the submit minted, and strips the routing key", async () => {
    const { ns, calls } = fakeNamespace((name) => {
      // The container only ever knows its OWN id. If the door forwarded the compound, this 404s --
      // which is precisely the silent "job gone" this scheme exists to prevent.
      if (name !== RK) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ status: "completed", result: { ok: true } }), { status: 200 });
    });
    const door = videoFinishDoor(ns, fixedDeps(RK));

    const resp = await door.fetch("/async/status/" + RK + COMPOUND_SEPARATOR + CJID);
    const body = (await resp.json()) as { status: string };

    expect(resp.status).toBe(200);
    expect(body.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe(RK);
    // The container receives its OWN id, never the compound.
    expect(calls[0].url).toBe("http://video-finish/async/status/" + CJID);
    expect(calls[0].url).not.toContain(COMPOUND_SEPARATOR + CJID);
  });

  it("CROSS-INSTANCE REFUSAL: a compound minted for instance A never resolves to instance B", async () => {
    const OTHER = "ffffffffffffffffffffffffffffffff";
    const { ns, calls } = fakeNamespace(() => new Response("{}", { status: 200 }));
    const door = videoFinishDoor(ns, fixedDeps(OTHER));

    // The routing key in the id, NOT the door's current minting key, decides the instance. If the
    // door ever addressed by anything else -- a fresh key, getRandom, a pool slot -- this is the
    // assertion that goes red.
    await door.fetch("/async/status/" + RK + COMPOUND_SEPARATOR + CJID);

    expect(calls[0].name).toBe(RK);
    expect(calls[0].name).not.toBe(OTHER);
  });

  it("refuses to guess an instance for an id that carries no routing key", async () => {
    const { ns, calls } = fakeNamespace(() => new Response("{}", { status: 200 }));
    const door = videoFinishDoor(ns, fixedDeps(RK));

    // A bare container id, e.g. from a job submitted before this door existed.
    const resp = await door.fetch("/async/status/" + CJID);

    expect(resp.status).toBe(404);
    // NOTHING was dispatched. Guessing an instance would poll a container that never ran this job
    // and report it gone, which is worse than admitting the id is unroutable -- core counts a 404
    // against ASSEMBLE_NOTFOUND_STREAK instead of failing the film on the first miss.
    expect(calls).toHaveLength(0);
  });

  it("statusInstanceName produces its negative on every unroutable shape", () => {
    expect(statusInstanceName("/async/status/" + RK + COMPOUND_SEPARATOR + CJID)).toBe(RK);
    expect(statusInstanceName("/async/status/" + CJID)).toBeNull();
    expect(statusInstanceName("/async/status/" + COMPOUND_SEPARATOR + CJID)).toBeNull();
    expect(statusInstanceName("/async/finish")).toBeNull();
    expect(statusInstanceName("/health")).toBeNull();
  });

  it("splits on the FIRST separator, so a container id could carry one and still route", async () => {
    const { ns, calls } = fakeNamespace(() => new Response("{}", { status: 200 }));
    const door = videoFinishDoor(ns, fixedDeps(RK));

    await door.fetch("/async/status/" + RK + ".a.b");

    expect(calls[0].name).toBe(RK);
    expect(calls[0].url).toBe("http://video-finish/async/status/" + encodeURIComponent("a.b"));
  });
});

describe("cf#810 video-finish door: stateless routes", () => {
  it("sends a stateless route to the bounded pool, never to a per-job instance", async () => {
    const { ns, calls } = fakeNamespace(() => new Response("{}", { status: 200 }));
    const door = videoFinishDoor(ns, fixedDeps(RK, 2));

    await door.fetch("/inspect", { method: "POST" });
    await door.fetch("/health");

    expect(calls.map((c) => c.name)).toEqual(["sync-2", "sync-2"]);
    // The routing key is for jobs. A stateless call must not consume a job-addressed instance.
    expect(calls.map((c) => c.name)).not.toContain(RK);
  });

  it("the production pool index stays inside the pool", () => {
    for (let i = 0; i < 500; i++) {
      const idx = productionDoorDeps.poolIndex();
      expect(Number.isInteger(idx)).toBe(true);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(SYNC_POOL_SIZE);
    }
  });

  it("the production routing key is 32 hex characters and carries no separator", () => {
    for (let i = 0; i < 50; i++) {
      const rk = productionDoorDeps.routingKey();
      expect(rk).toMatch(/^[0-9a-f]{32}$/);
      // A key containing the separator would make the compound ambiguous on a first-dot split.
      expect(rk).not.toContain(COMPOUND_SEPARATOR);
    }
  });

  it("a submit is only a submit on POST, so a GET of the same path is not given a job instance", async () => {
    const { ns, calls } = fakeNamespace(() => new Response("{}", { status: 200 }));
    const door = videoFinishDoor(ns, fixedDeps(RK, 1));

    await door.fetch("/async/finish");

    expect(calls[0].name).toBe("sync-1");
    expect(calls[0].name).not.toBe(RK);
  });
});
