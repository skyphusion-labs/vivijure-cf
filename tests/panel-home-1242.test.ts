import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { panelHomeIsSimple, studioPageAsset, whoamiBody } from "../src/panel-home";

// cf#1242: PANEL_HOME decides the landing page. Unset must leave "/" exactly as it was.

function makeEnv(extra: Record<string, unknown> = {}) {
  const assetCalls: string[] = [];
  const env = {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: {
      fetch: async (req: Request) => {
        assetCalls.push(new URL(req.url).pathname);
        return new Response("ASSET", { status: 200, headers: { "content-type": "text/html" } });
      },
    },
    ...extra,
  } as unknown as Env;
  return { env, assetCalls };
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const get = (path: string) => new Request(`https://studio.example${path}`);

describe("PANEL_HOME unset keeps today's behaviour", () => {
  for (const path of ["/", "/index.html"]) {
    it(`GET ${path} still serves the planner`, async () => {
      const { env, assetCalls } = makeEnv();
      await worker.fetch(get(path), env, ctx);
      expect(assetCalls).toEqual(["/planner.html"]);
    });
  }
  it("GET /api/whoami is byte-for-byte the old body", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(get("/api/whoami"), env, ctx);
    expect(await res.text()).toBe(JSON.stringify({ user: "studio" }));
  });
  it("any value but simple is unset", () => {
    for (const v of [undefined, "", "planner", "simpler", "advanced"]) expect(panelHomeIsSimple({ PANEL_HOME: v })).toBe(false);
  });
});

describe("PANEL_HOME=simple", () => {
  for (const path of ["/", "/index.html"]) {
    it(`GET ${path} serves Make a video`, async () => {
      const { env, assetCalls } = makeEnv({ PANEL_HOME: "simple" });
      await worker.fetch(get(path), env, ctx);
      expect(assetCalls).toEqual(["/make.html"]);
    });
  }
  it("the planner stays reachable at /planner", async () => {
    const { env, assetCalls } = makeEnv({ PANEL_HOME: "simple" });
    await worker.fetch(get("/planner"), env, ctx);
    expect(assetCalls).toEqual(["/planner.html"]);
  });
  it("GET /api/whoami tells the nav", async () => {
    const { env } = makeEnv({ PANEL_HOME: "simple" });
    const res = await worker.fetch(get("/api/whoami"), env, ctx);
    expect(await res.json()).toEqual({ user: "studio", panel_home: "simple" });
  });
  it("case and spaces are forgiven", () => {
    expect(panelHomeIsSimple({ PANEL_HOME: " Simple " })).toBe(true);
    expect(whoamiBody({ PANEL_HOME: "SIMPLE" }).panel_home).toBe("simple");
  });
});

describe("/make is always there", () => {
  for (const path of ["/make", "/make/"]) {
    it(`GET ${path} serves make.html with the studio page CSP, setting or not`, async () => {
      for (const extra of [{}, { PANEL_HOME: "simple" }]) {
        const { env, assetCalls } = makeEnv(extra);
        const res = await worker.fetch(get(path), env, ctx);
        expect(assetCalls).toEqual(["/make.html"]);
        expect(res.headers.get("content-security-policy") || "").not.toContain("default-src 'none'");
      }
    });
  }
  it("studioPageAsset leaves non-root paths to the table", () => {
    expect(studioPageAsset({ "/cast": "/cast.html" }, "/cast", { PANEL_HOME: "simple" })).toBe("/cast.html");
    expect(studioPageAsset({}, "/nope", { PANEL_HOME: "simple" })).toBeUndefined();
  });
});
