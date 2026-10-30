// cf#926: preflight honors the door's published duration bounds, and refuses a door that is not there.
// The manifests come from the real module workers, so these tests read what the door really publishes
// and not a stub of it.
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import cfVeoWorker from "../modules/cf-veo/src/index";
import infinitetalkWorker from "../modules/infinitetalk/src/index";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type Door = { fetch(request: Request, env: never): Promise<Response> };

function env(): Env {
  const bind = (d: unknown) => ({
    fetch: (input: string, init?: RequestInit) => (d as Door).fetch(new Request(input, init), {} as never),
  });
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    MODULE_CF_VEO: bind(cfVeoWorker),
    MODULE_INFINITETALK: bind(infinitetalkWorker),
  } as unknown as Env;
}

interface Result {
  ok: boolean;
  issues: { level: string; scope: string; message: string }[];
}

async function preflight(seconds: number | undefined, extra: Record<string, unknown>): Promise<Result> {
  const scene: Record<string, unknown> = { id: "shot_01", prompt: "a wide neon alley in the rain at night" };
  if (seconds !== undefined) scene.target_seconds = seconds;
  const res = await worker.fetch(
    new Request("https://studio.example/api/storyboard/preflight", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storyboard: { title: "door_check", scenes: [scene] }, ...extra }),
    }),
    env(),
    ctx,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Result;
}

const doorIssues = (r: Result) => r.issues.filter((i) => /renders/.test(i.message));

describe("cf#926 preflight reads the named door's usage", () => {
  beforeEach(() => _resetModuleDiscoveryCache());

  it("20s on cf-veo is an error that names the door and its steps", async () => {
    const r = await preflight(20, { motionBackend: "cf-veo" });
    expect(r.ok).toBe(false);
    const hit = doorIssues(r).find((i) => i.level === "error");
    expect(hit?.scope).toBe("scene[shot_01]");
    expect(hit?.message).toMatch(/cf-veo/);
    expect(hit?.message).toMatch(/4, 6, 8 seconds/);
  });

  it("the case #926 measured: 20s on infinitetalk, a door with no steps", async () => {
    const r = await preflight(20, { motionBackend: "infinitetalk" });
    expect(r.ok).toBe(false);
    expect(doorIssues(r)[0]?.message).toMatch(/at most 15s/);
  });

  it("the snake_case key the issue used is read too, so it cannot drop the check", async () => {
    expect((await preflight(20, { motion_backend: "cf-veo" })).ok).toBe(false);
  });

  it("a shot on a step is clean", async () => {
    const r = await preflight(6, { motionBackend: "cf-veo" });
    expect(r.ok).toBe(true);
    expect(doorIssues(r)).toEqual([]);
  });

  it("a shot between steps warns and does not block", async () => {
    const r = await preflight(5, { motionBackend: "cf-veo" });
    expect(r.ok).toBe(true);
    expect(doorIssues(r).map((i) => i.level)).toEqual(["warning"]);
    expect(doorIssues(r)[0].message).toMatch(/4, 6, 8 seconds/);
  });

  it("a shot under the floor warns and does not block", async () => {
    const r = await preflight(2, { motionBackend: "cf-veo" });
    expect(r.ok).toBe(true);
    expect(doorIssues(r)[0].message).toMatch(/at least 4s/);
  });

  it("a shot with no planned length reads nothing into the door", async () => {
    expect(doorIssues(await preflight(undefined, { motionBackend: "cf-veo" }))).toEqual([]);
  });

  it("no door named keeps the old behavior", async () => {
    const r = await preflight(20, {});
    expect(r.ok).toBe(true);
    expect(doorIssues(r)).toEqual([]);
  });

  it("a door that is not installed is an error, with the same shot otherwise clean", async () => {
    const r = await preflight(6, { motionBackend: "does-not-exist" });
    expect(r.ok).toBe(false);
    const hit = r.issues.find((i) => i.scope === "motionBackend");
    expect(hit?.level).toBe("error");
    expect(hit?.message).toMatch(/does-not-exist/);
    expect(hit?.message).toMatch(/cf-veo/);
  });
});
