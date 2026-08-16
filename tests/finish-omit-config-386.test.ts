import { describe, it, expect, vi } from "vitest";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import {
  resolveAgentFinishSelect,
  finishSelectPreflightError,
} from "../src/render-door";
import worker from "../src/index";
import type { Env } from "../src/env";

// cf#386 + cf#593. Two hosted-film lies, one door:
//   omit finish_config on POST /api/render/film used to run default rife+upscale
//   a named finish module not in the registry used to drop silently
//
// Read against the existing omit-config docs (CONTRACT used to say omit = schema defaults) and
// against cf#537 (finish_select is the explicit list). Product: an MCP/API caller who does not
// mention finish must not get billed polish; a named ghost must 400 before GPU spend.

const h = vi.hoisted(() => ({ started: [] as Array<Record<string, unknown>> }));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: Record<string, unknown>) => {
      h.started.push(args);
      return { film_id: "film-omit", phase: "keyframe", scenes: args.scenes, project: "p", created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => {}) };
});
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => []) };
});

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function moduleBinding(name: string, hooks: string[], extra?: Record<string, unknown>) {
  return {
    fetch: async () =>
      new Response(
        JSON.stringify({
          name,
          version: "0.1.0",
          api: MODULE_API,
          hooks,
          ui: { order: 10 },
          ...extra,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  };
}

const env = {
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("ASSET") },
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  MODULE_KEYFRAME: moduleBinding("keyframe-sdxl", ["keyframe"]),
  MODULE_ALIBABA_WAN: moduleBinding("alibaba-wan", ["motion.backend"]),
  MODULE_FINISH_UPSCALE: moduleBinding("finish-upscale", ["finish"], { participation: "default" }),
} as unknown as Env;

function post(body: unknown): Request {
  return new Request("https://studio.example/api/render/film", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BASE = {
  bundle_key: "bundles/good.tar.gz",
  scenes: [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }],
  motion_backend: "alibaba-wan",
};

const serving = [
  {
    name: "finish-upscale",
    version: "0.1.0",
    api: MODULE_API,
    hooks: ["finish" as const],
    binding: "MODULE_FINISH_UPSCALE",
    participation: "default" as const,
  },
];

describe("cf#386 resolveAgentFinishSelect: omit vs explicit", () => {
  it("omitted finish_config and finish_select -> named empty (no finish)", () => {
    expect(resolveAgentFinishSelect(undefined, undefined)).toEqual({ mode: "named", modules: [] });
  });

  it("explicit empty finish_config -> named empty, not default participation", () => {
    expect(resolveAgentFinishSelect(undefined, {})).toEqual({ mode: "named", modules: [] });
  });

  it("finish_config keys become the named list when finish_select is omitted", () => {
    expect(resolveAgentFinishSelect(undefined, { "finish-upscale": { scale: 2 } })).toEqual({
      mode: "named",
      modules: ["finish-upscale"],
    });
  });

  it("finish-order is an orchestrator modifier, not a named module", () => {
    expect(
      resolveAgentFinishSelect(undefined, {
        "finish-order": { dialogue_reorder: true },
        "finish-upscale": { scale: 2 },
      }),
    ).toEqual({ mode: "named", modules: ["finish-upscale"] });
  });

  it("explicit finish_select wins over finish_config keys", () => {
    expect(
      resolveAgentFinishSelect(
        { mode: "named", modules: ["finish-rife"] },
        { "finish-upscale": { scale: 2 } },
      ),
    ).toEqual({ mode: "named", modules: ["finish-rife"] });
  });

  it("{ mode: \"default\" } is how a caller still asks for the participation set", () => {
    expect(resolveAgentFinishSelect({ mode: "default" }, undefined)).toEqual({ mode: "default" });
  });

  it("CONTROL: a well-formed named list is not rewritten into empty", () => {
    expect(resolveAgentFinishSelect({ mode: "named", modules: ["finish-upscale"] }, undefined)).toEqual({
      mode: "named",
      modules: ["finish-upscale"],
    });
  });
});

describe("cf#593 finishSelectPreflightError: named-but-not-serving fails closed", () => {
  it("ghost name -> error that names the module", () => {
    const err = finishSelectPreflightError(serving, { mode: "named", modules: ["ghost"] });
    expect(err).toBe("finish module(s) requested but not serving: ghost");
  });

  it("serving name -> no error", () => {
    expect(finishSelectPreflightError(serving, { mode: "named", modules: ["finish-upscale"] })).toBeNull();
  });

  it("default / omitted selection has no missing set (panel path stays default participation)", () => {
    expect(finishSelectPreflightError(serving, undefined)).toBeNull();
    expect(finishSelectPreflightError(serving, { mode: "default" })).toBeNull();
  });

  it("CONTROL: named empty is not an error (explicit no-finish)", () => {
    expect(finishSelectPreflightError(serving, { mode: "named", modules: [] })).toBeNull();
  });
});

describe("cf#386 / cf#593 POST /api/render/film door", () => {
  it("omitting finish_config mints named-empty: no default rife+upscale", async () => {
    h.started = [];
    const res = await worker.fetch(post(BASE), env, ctx);
    expect(res.status).toBe(201);
    expect(h.started).toHaveLength(1);
    expect(h.started[0].finish_select).toEqual({ mode: "named", modules: [] });
    expect(h.started[0].finish_config).toBeUndefined();
  });

  it("explicit finish-upscale config is the list, and the serving module is accepted", async () => {
    h.started = [];
    const res = await worker.fetch(
      post({ ...BASE, finish_config: { "finish-upscale": { scale: 2 } } }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started).toHaveLength(1);
    expect(h.started[0].finish_select).toEqual({ mode: "named", modules: ["finish-upscale"] });
    expect(h.started[0].finish_config).toEqual({ "finish-upscale": { scale: 2 } });
  });

  it("finish_select: { mode: \"default\" } still asks for the participation set", async () => {
    h.started = [];
    const res = await worker.fetch(post({ ...BASE, finish_select: { mode: "default" } }), env, ctx);
    expect(res.status).toBe(201);
    expect(h.started[0].finish_select).toEqual({ mode: "default" });
  });

  it("named ghost 400s before startFilmJob (fail closed, not a bare film after GPU)", async () => {
    h.started = [];
    const res = await worker.fetch(
      post({ ...BASE, finish_select: { mode: "named", modules: ["ghost"] } }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error?: string };
    expect(parsed.error ?? "").toContain("ghost");
    expect(parsed.error ?? "").toContain("not serving");
    expect(h.started.length, "must bounce before startFilmJob").toBe(0);
  });

  it("finish_config key for a module this studio does not serve is the same 400", async () => {
    h.started = [];
    const res = await worker.fetch(
      post({ ...BASE, finish_config: { "finish-blender": { preset: "high_contrast" } } }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error?: string };
    expect(parsed.error ?? "").toContain("finish-blender");
    expect(h.started.length).toBe(0);
  });
});

describe("cf#386 CONTRACT no longer documents omit = defaults for finish", () => {
  it("the old sentence is gone and the new omit rule is stated", async () => {
    const { readFileSync } = await import("node:fs");
    const contract = readFileSync("docs/CONTRACT.md", "utf8");
    expect(contract).not.toMatch(/Omitting a `\*_config` does NOT skip the chain/);
    expect(contract).toMatch(/Omitting `finish_config` \(and `finish_select`\) skips the finish chain/);
    expect(contract).toContain("finish module(s) requested but not serving");
  });
});
