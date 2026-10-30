import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CAPACITY_ERROR,
  FINISH_AFFINITY_HEADER,
  affinityRoutingKey,
  isCapacityRefusalText,
  videoFinishDoor,
  type VideoFinishDoorDeps,
} from "../src/video-finish-binding";
import { tickVideoFinishAssemble } from "@skyphusion-labs/vivijure-core/video-finish-assemble";

// A finish instance limit answers a submit with a 500. Core could not tell that from a crash, so
// six films with paid clips failed terminally. The door turns it into the one status core retries.

const MAX = "Failed to start container: Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances";
const NO_INSTANCE = "There is no Container instance available at this time.\nThis is likely because you have reached your max concurrent instance count";

function door(handler: (name: string) => Response | Promise<Response>) {
  const names: string[] = [];
  const ns = {
    idFromName: (name: string) => ({ __name: name }),
    get: (id: { __name: string }) => ({
      fetch: async () => {
        names.push(id.__name);
        return handler(id.__name);
      },
    }),
  };
  let n = 0;
  const deps: VideoFinishDoorDeps = { routingKey: () => `random${n++}`, poolIndex: () => 0 };
  return { d: videoFinishDoor(ns as never, deps), names };
}

const submit = (headers: Record<string, string> = {}) => ({ method: "POST", headers, body: "{}" });

afterEach(() => vi.restoreAllMocks());

describe("capacity refusals at submit", () => {
  it.each([
    ["the 500 the base class returns at the limit", 500, MAX],
    ["the 503 the base class returns with no instance", 503, NO_INSTANCE],
    ["the 429 the base class returns when rate limited", 429, "rate limited"],
  ])("rewrites %s to a 429 naming the cause", async (_name, status, text) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { d } = door(() => new Response(text, { status }));
    const resp = await d.fetch("http://video-finish/async/finish", submit());
    expect(resp.status).toBe(429);
    const body = (await resp.json()) as { error: string; detail: string };
    expect(body.error).toBe(CAPACITY_ERROR);
    expect(body.detail).toBe(text.slice(0, 240));
  });

  it("rewrites a thrown capacity error instead of rethrowing it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { d } = door(() => { throw new Error(MAX); });
    const resp = await d.fetch("http://video-finish/async/finish", submit());
    expect(resp.status).toBe(429);
  });

  it("still rethrows any other thrown error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { d } = door(() => { throw new Error("socket closed"); });
    await expect(d.fetch("http://video-finish/async/finish", submit())).rejects.toThrow("socket closed");
  });

  it("passes a real 500 through untouched: a crash must stay a crash", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { d } = door(() => new Response("Failed to start container: crashed while checking for ports", { status: 500 }));
    const resp = await d.fetch("http://video-finish/async/finish", submit());
    expect(resp.status).toBe(500);
    expect(await resp.text()).toContain("crashed while checking");
  });

  it("does not rewrite a 503 with other words", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { d } = door(() => new Response("upstream down", { status: 503 }));
    expect((await d.fetch("http://video-finish/async/finish", submit())).status).toBe(503);
  });

  it("logs the capacity outcome without a request body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { d } = door(() => new Response(MAX, { status: 500 }));
    await d.fetch("http://video-finish/async/finish", submit());
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain('"outcome":"capacity"');
  });

  it("does not rewrite a stateless route: it is not a submit", async () => {
    const { d } = door(() => new Response(MAX, { status: 500 }));
    expect((await d.fetch("http://video-finish/inspect", { method: "POST", body: "{}" })).status).toBe(500);
  });
});

describe("routing key per film", () => {
  it("sends every attempt for a film to one instance", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { d, names } = door(() => new Response(MAX, { status: 500 }));
    const h = { [FINISH_AFFINITY_HEADER]: "film-a" };
    await d.fetch("http://video-finish/async/finish", submit(h));
    await d.fetch("http://video-finish/async/finish", submit(h));
    expect(names[0]).toBe(names[1]);
    expect(names[0]).toBe(await affinityRoutingKey("film-a"));
    expect(names[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sends two films to two instances", async () => {
    expect(await affinityRoutingKey("film-a")).not.toBe(await affinityRoutingKey("film-b"));
  });

  it("still mints a random key when no film is named", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { d, names } = door(() => new Response(MAX, { status: 500 }));
    await d.fetch("http://video-finish/async/finish", submit());
    await d.fetch("http://video-finish/async/finish", submit());
    expect(names).toEqual(["random0", "random1"]);
  });

  it("makes a poll reach the film's instance", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { d, names } = door((name) => (names.length === 1
      ? new Response(JSON.stringify({ ok: true, jobId: "abc", status: "pending" }), { status: 202 })
      : new Response(JSON.stringify({ status: "pending", at: name }), { status: 200 })));
    const accepted = await d.fetch("http://video-finish/async/finish", submit({ [FINISH_AFFINITY_HEADER]: "film-a" }));
    const { jobId } = (await accepted.json()) as { jobId: string };
    await d.fetch(`http://video-finish/async/status/${encodeURIComponent(jobId)}`, {});
    expect(names[1]).toBe(names[0]);
  });
});

describe("isCapacityRefusalText", () => {
  it("does not match an ordinary crash", () => {
    expect(isCapacityRefusalText("Container crashed while checking for ports")).toBe(false);
    expect(isCapacityRefusalText(MAX)).toBe(true);
  });
});

// The door and core meet here with no stub between them: the real door over a fake namespace, driven by
// the real published tick. This is the seam the two PRs share, so neither side's own tests can see it.
describe("the door and the pinned core together", () => {
  const coreEnv = (d: unknown) =>
    ({ VIDEO_FINISH_URL: "http://video-finish", MEDIA_FINISH_TOKEN: "t", MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: d } }) as never;
  const payload = { clips: [{ url: "https://r2/c.mp4" }], outputUrl: "https://r2/o.mp4", outputKey: "renders/f/film.mp4" };

  it("the platform limit becomes a wait, naming the cause, on the film's own instance", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { d, names } = door(() => new Response(MAX, { status: 500 }));
    const tick = await tickVideoFinishAssemble(coreEnv(d), payload, undefined, { affinity: "film-a" });
    if (tick.kind !== "waiting") throw new Error(`expected waiting, got ${tick.kind}`);
    expect(tick.detail).toContain("Maximum number of running container instances");
    expect(names).toEqual([await affinityRoutingKey("film-a")]);
  });

  it("a crash stays terminal and names its own words", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { d } = door(() => new Response("Failed to start container: crashed while checking for ports", { status: 500 }));
    const tick = await tickVideoFinishAssemble(coreEnv(d), payload, undefined, { affinity: "film-a" });
    if (tick.kind !== "failed") throw new Error(`expected failed, got ${tick.kind}`);
    expect(tick.error).toContain("crashed while checking");
  });
});
