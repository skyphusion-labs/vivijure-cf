import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  videoFinishDoor,
  videoFinishDoorOf,
  pathOf,
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
// The origin core prefixes onto every bound-path call. The hostname is a LABEL; nothing
// resolves it. Tests use it because it is the real input shape, not a convenience.
const ORIGIN = "http://video-finish";

describe("cf#810 video-finish door: submit", () => {
  it("routes a submit to a fresh instance and rewrites the job id to a routable compound", async () => {
    const { ns, calls } = fakeNamespace(accepts(CJID));
    const door = videoFinishDoor(ns, fixedDeps(RK));

    const resp = await door.fetch(ORIGIN + "/async/finish", { method: "POST", body: "{}" });
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

    const resp = await door.fetch(ORIGIN + "/async/finish", { method: "POST", body: "{}" });
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

    const resp = await door.fetch(ORIGIN + "/async/finish", { method: "POST", body: "{}" });
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

    const resp = await door.fetch(ORIGIN + "/async/status/" + RK + COMPOUND_SEPARATOR + CJID);
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
    await door.fetch(ORIGIN + "/async/status/" + RK + COMPOUND_SEPARATOR + CJID);

    expect(calls[0].name).toBe(RK);
    expect(calls[0].name).not.toBe(OTHER);
  });

  it("refuses to guess an instance for an id that carries no routing key", async () => {
    const { ns, calls } = fakeNamespace(() => new Response("{}", { status: 200 }));
    const door = videoFinishDoor(ns, fixedDeps(RK));

    // A bare container id, e.g. from a job submitted before this door existed.
    const resp = await door.fetch(ORIGIN + "/async/status/" + CJID);

    expect(resp.status).toBe(404);
    // NOTHING was dispatched. Guessing an instance would poll a container that never ran this job
    // and report it gone, which is worse than admitting the id is unroutable -- core counts a 404
    // against ASSEMBLE_NOTFOUND_STREAK instead of failing the film on the first miss.
    expect(calls).toHaveLength(0);
  });

  it("statusInstanceName produces its negative on every unroutable shape", () => {
    expect(statusInstanceName(ORIGIN + "/async/status/" + RK + COMPOUND_SEPARATOR + CJID)).toBe(RK);
    expect(statusInstanceName(ORIGIN + "/async/status/" + CJID)).toBeNull();
    expect(statusInstanceName(ORIGIN + "/async/status/" + COMPOUND_SEPARATOR + CJID)).toBeNull();
    expect(statusInstanceName(ORIGIN + "/async/finish")).toBeNull();
    expect(statusInstanceName(ORIGIN + "/health")).toBeNull();
  });

  it("splits on the FIRST separator, so a container id could carry one and still route", async () => {
    const { ns, calls } = fakeNamespace(() => new Response("{}", { status: 200 }));
    const door = videoFinishDoor(ns, fixedDeps(RK));

    await door.fetch(ORIGIN + "/async/status/" + RK + ".a.b");

    expect(calls[0].name).toBe(RK);
    expect(calls[0].url).toBe("http://video-finish/async/status/" + encodeURIComponent("a.b"));
  });
});

describe("cf#810 video-finish door: stateless routes", () => {
  it("sends a stateless route to the bounded pool, never to a per-job instance", async () => {
    const { ns, calls } = fakeNamespace(() => new Response("{}", { status: 200 }));
    const door = videoFinishDoor(ns, fixedDeps(RK, 2));

    await door.fetch(ORIGIN + "/inspect", { method: "POST" });
    await door.fetch(ORIGIN + "/health");

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

    await door.fetch(ORIGIN + "/async/finish");

    expect(calls[0].name).toBe("sync-1");
    expect(calls[0].name).not.toBe(RK);
  });
});

describe("cf#810 the shape core actually calls with", () => {
  it("accepts the absolute url core sends, and keeps the query string", () => {
    expect(pathOf("http://video-finish/async/finish")).toBe("/async/finish");
    expect(pathOf("http://video-finish/frames?count=9")).toBe("/frames?count=9");
    // A bare path is still handled, so a caller that passes one is not silently misrouted.
    expect(pathOf("/inspect")).toBe("/inspect");
    expect(pathOf("inspect")).toBe("/inspect");
  });

  it("routes a submit sent as an absolute url, not as a path", async () => {
    const { ns, calls } = fakeNamespace(accepts(CJID));
    const door = videoFinishDoor(ns, fixedDeps(RK));

    const resp = await door.fetch(ORIGIN + "/async/finish", { method: "POST", body: "{}" });
    const body = (await resp.json()) as { jobId: string };

    expect(calls[0].name).toBe(RK);
    // The bug this pins: treating the absolute url as a path yields
    // "/http://video-finish/async/finish", which the container 404s.
    expect(calls[0].url).toBe(ORIGIN + "/async/finish");
    expect(calls[0].url).not.toContain("/http:");
    expect(body.jobId).toBe(RK + COMPOUND_SEPARATOR + CJID);
  });

  it("videoFinishDoorOf reads the door core's way, and rejects a non-door", () => {
    const door = { fetch: async () => new Response("{}") };
    expect(videoFinishDoorOf({ MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: door } })).toBe(door);
    expect(videoFinishDoorOf({})).toBeNull();
    expect(videoFinishDoorOf({ MEDIA_DOOR_FETCHERS: {} })).toBeNull();
    // Duck-typed on `fetch`, exactly as core's mediaDoorFetcher is, so the two agree on what
    // counts as bound rather than each having an opinion.
    expect(videoFinishDoorOf({ MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: {} as never } })).toBeNull();
  });
});


// -------------------------------------------------------------------------------------------------
// cf#843: a submit attempt must be ATTRIBUTABLE to the instance record it creates.
//
// `routingKey()` is minted per attempt, so every attempt addresses a fresh Durable Object and creates
// a fresh instance record. During film-40e0cd09 the list grew by one about every five minutes while
// assemble was stuck, and afterwards nothing could say which attempt made which record: the instances
// endpoint carries only {application_id, id, image, name, status}. cf#843 declined to guess between
// "a second attempt" and "the first request landing late", which was right and is also the gap.
//
// The load-bearing case is the LAST one. The submit payload carries SigV4-presigned R2 URLs, so a log
// line near it is a leak vector before it is an observability feature.
// -------------------------------------------------------------------------------------------------
describe("cf#843: every submit attempt is attributable, and nothing leaks into the line", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  // Cleared BEFORE each case as well as after: the spy is installed when this describe body runs,
  // which is before any test in the file executes, so the earlier door suites above accumulate their
  // own submit lines into the same buffer. The first version cleared only afterwards and read 10
  // lines where it expected 2 -- a false FAILURE rather than a false pass, which is the direction to
  // be wrong in, but still a harness bug rather than a finding.
  beforeEach(() => log.mockClear());
  afterEach(() => log.mockClear());

  const submitInit = (body: string) => ({ method: "POST", body } as RequestInit);
  const lines = () =>
    log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"finish.submit"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("logs the attempt BEFORE the call, then the accepted outcome with the container job id", async () => {
    const { ns } = fakeNamespace(accepts(CJID));
    const door = videoFinishDoor(ns, fixedDeps(RK));
    await door.fetch(ORIGIN + "/async/finish", submitInit("{}"));
    const l = lines();
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({ phase: "attempt", routing_key: RK, path: "/async/finish" });
    expect(l[1]).toMatchObject({ phase: "outcome", routing_key: RK, outcome: "accepted", container_job_id: CJID });
    // ordering is the whole argument for the first line: the record exists once the object is addressed
    expect(l[0].phase).toBe("attempt");
  });

  it("a non-202 is reported as rejected, with the status", async () => {
    const { ns } = fakeNamespace(() => new Response("nope", { status: 503 }));
    const door = videoFinishDoor(ns, fixedDeps(RK));
    await door.fetch(ORIGIN + "/async/finish", submitInit("{}"));
    expect(lines()[1]).toMatchObject({ phase: "outcome", outcome: "rejected", status: 503 });
  });

  it("a 202 with no usable jobId is reported as malformed rather than passing silently", async () => {
    const { ns } = fakeNamespace(() => new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json" } }));
    const door = videoFinishDoor(ns, fixedDeps(RK));
    await door.fetch(ORIGIN + "/async/finish", submitInit("{}"));
    expect(lines()[1]).toMatchObject({ phase: "outcome", outcome: "malformed" });
  });

  it("a THROWING call still logs the attempt, reports threw, and rethrows unchanged", async () => {
    // The case a post-hoc-only line would lose: the object was addressed, so the record exists.
    const ns = {
      idFromName: (name: string) => ({ __name: name }),
      get: () => ({ fetch: async () => { throw new Error("container unreachable"); } }),
    } as never;
    const door = videoFinishDoor(ns, fixedDeps(RK));
    await expect(door.fetch(ORIGIN + "/async/finish", submitInit("{}"))).rejects.toThrow("container unreachable");
    const l = lines();
    expect(l[0]).toMatchObject({ phase: "attempt", routing_key: RK });
    expect(l[1]).toMatchObject({ phase: "outcome", outcome: "threw" });
  });

  it("NEVER logs the request body: a presigned URL in the payload appears in no line", async () => {
    // The leak guard, and the reason this suite exists rather than just the feature.
    const SECRETISH = "https://acct.r2.cloudflarestorage.com/vivijure/x.mp4?X-Amz-Signature=deadbeefcafe";
    const { ns } = fakeNamespace(accepts(CJID));
    const door = videoFinishDoor(ns, fixedDeps(RK));
    await door.fetch(ORIGIN + "/async/finish", submitInit(JSON.stringify({ clip_urls: [SECRETISH] })));
    const all = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).not.toContain("X-Amz-Signature");
    expect(all).not.toContain(SECRETISH);
    expect(all).not.toContain("r2.cloudflarestorage.com");
    // and the control: the lines DID get emitted, so this is not passing because nothing logged
    expect(lines()).toHaveLength(2);
  });

  it("a POLL is not a submit, so it mints no key and logs no attempt", async () => {
    const { ns } = fakeNamespace(() => new Response("{}", { status: 200 }));
    const door = videoFinishDoor(ns, fixedDeps(RK));
    await door.fetch(ORIGIN + "/async/status/" + RK + COMPOUND_SEPARATOR + CJID, { method: "GET" });
    expect(lines()).toHaveLength(0);
  });
});
