import { describe, it, expect, vi, beforeEach } from "vitest";

// Phase C Part 2 (cf#29): the Wan cast-LoRA projection. resolveCastLoras (core) sorts a bound cast
// into DISJOINT SDXL (`pretrained`) and Wan (`wanPretrained`) maps; this cf-side projection turns a
// Wan cast's two-expert R2 keys into presigned URLs inside the alibaba-wan-lora module config
// (high_noise_loras / low_noise_loras), at ALL THREE render submit paths (render, film, scatter).
//
// The load-bearing invariant these tests pin: a Wan cast projects ONLY the Wan config fields (never
// pretrained_loras), an SDXL cast projects ONLY pretrained_loras (never the Wan fields), and this
// holds at EACH of the three paths -- scatter especially, which forwards render_overrides RAW and
// resolves per-shard downstream (the divergence that would otherwise ship a Wan cast LoRA-less).

// --- deterministic presign: URL echoes the key + TTL so assertions can see both -------------------
vi.mock("../src/r2-presign", async (orig) => {
  const actual = await orig<typeof import("../src/r2-presign")>();
  return {
    ...actual,
    presignR2Get: vi.fn(async (_env: unknown, key: string, ttl?: number) => `https://r2.example/${key}?sig=X&ttl=${ttl}`),
  };
});

// --- cast resolution keyed off the castLoras marker: "wan" | "sdxl" | (anything else -> empty) -----
const WAN_HIGH = "loras/cast-5/1700000000.high.safetensors";
const WAN_LOW = "loras/cast-5/1700000000.low.safetensors";
const SDXL_KEY = "loras/cast-9/1700000000.safetensors";
function castResult(marker: unknown) {
  if (marker === "wan") {
    return { pretrained: {}, wanPretrained: { A: { high: WAN_HIGH, low: WAN_LOW } }, voices: {}, castIds: { A: 5 }, skipped: [], skippedDetail: [] };
  }
  if (marker === "sdxl") {
    return { pretrained: { A: SDXL_KEY }, wanPretrained: {}, voices: {}, castIds: { A: 9 }, skipped: [], skippedDetail: [] };
  }
  return { pretrained: {}, wanPretrained: {}, voices: {}, castIds: {}, skipped: [], skippedDetail: [] };
}
vi.mock("@skyphusion-labs/vivijure-core/cast-loras", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/cast-loras")>();
  return {
    ...actual,
    resolveCastLoras: vi.fn(async (_env: unknown, castLoras: Record<string, unknown> | undefined) => castResult(castLoras?.A)),
  };
});

// --- capture what each door hands its orchestrator -------------------------------------------------
const cap = vi.hoisted(() => ({ film: [] as Array<Record<string, unknown>>, scatter: [] as Array<Record<string, unknown>>, wanTrainId: null as number | null }));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: Record<string, unknown>) => {
      cap.film.push(args);
      return { film_id: "film-wan-test", phase: "keyframe", scenes: args.scenes, project: "p", created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/scatter-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/scatter-orchestrator")>();
  return {
    ...actual,
    startScatterRender: vi.fn(async (_env: unknown, args: Record<string, unknown>) => {
      cap.scatter.push(args);
      return { scatter_id: "scatter-wan-test", phase: "shards" };
    }),
    scatterJobToPollView: vi.fn(() => ({ jobId: "scatter-wan-test", status: "in_progress" })),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => []) };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => {}) };
});
// Route wiring: prove POST /train-wan-lora reaches the core handler with the resolved id.
vi.mock("@skyphusion-labs/vivijure-core/cast-lora-train", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/cast-lora-train")>();
  return {
    ...actual,
    handleCastTrainWanLora: vi.fn(async (_req: unknown, _env: unknown, id: number) => {
      cap.wanTrainId = id;
      return new Response(JSON.stringify({ ok: true, via: "wan-train-handler" }), { status: 202, headers: { "content-type": "application/json" } });
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/cast-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/cast-db")>();
  return { ...actual, getCastIdByPublicId: vi.fn(async () => 5) };
});

import worker from "../src/index";
import { isSpendRoute } from "../src/rate-limit";
import {
  projectWanLorasIntoModuleConfig,
  shouldProjectWanLoras,
  ensureModuleOverrideConfig,
  WAN_LORA_BACKEND,
  WAN_LORA_DEFAULT_SCALE,
  WAN_LORA_PRESIGN_TTL_SECONDS,
  MAX_LORAS_PER_PASS,
} from "../src/wan-lora-projection";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import type { Env } from "../src/env";
import { orch } from "./orchestrator-env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const anyEnv = {} as unknown as Env;

function fakeModule(manifest: unknown) {
  return { fetch: async () => new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } }) };
}
// The real alibaba-wan-lora config_schema: high/low_noise_loras are DECLARED string fields, so they
// survive validateConfig on the scatter (pre-clamp) path.
const WAN_LORA_SCHEMA = {
  high_noise_loras: { type: "string", default: "[]", label: "high" },
  low_noise_loras: { type: "string", default: "[]", label: "low" },
  seed: { type: "int", default: -1, min: -1, label: "seed" },
  enable_safety_checker: { type: "bool", default: true, label: "safety" },
};
function env(): Env {
  return orch({
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET") },
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
    R2_RENDERS: { get: async () => null, head: async () => null, put: async () => {} },
    MODULE_KEYFRAME: fakeModule({ name: "cloud-keyframe", version: "0.1.0", api: MODULE_API, hooks: ["keyframe"] }),
    MODULE_ALIBABA_WAN_LORA: fakeModule({ name: "alibaba-wan-lora", version: "0.1.1", api: MODULE_API, hooks: ["motion.backend"], config_schema: WAN_LORA_SCHEMA, ui: { order: 75, locality: "cloud" } }),
  } as unknown as Env);
}
function post(path: string, body: unknown): Request {
  return new Request(`https://studio.example${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const SCENES = [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }];

beforeEach(() => { cap.film = []; cap.scatter = []; cap.wanTrainId = null; });

function parseLoras(v: unknown): Array<{ path: string; scale: number }> {
  return JSON.parse(String(v)) as Array<{ path: string; scale: number }>;
}

// ==================================================================================================
describe("projectWanLorasIntoModuleConfig -- the shared helper", () => {
  it("Wan cast + Wan backend: presigns both experts into high/low_noise_loras at scale 1.5", async () => {
    const cfg: Record<string, unknown> = { high_noise_loras: "[]", low_noise_loras: "[]" };
    const r = await projectWanLorasIntoModuleConfig(anyEnv, WAN_LORA_BACKEND, { A: { high: WAN_HIGH, low: WAN_LOW } }, cfg);
    expect(r).toEqual({ injected: 1, dropped: 0, applied: true });
    const high = parseLoras(cfg.high_noise_loras);
    const low = parseLoras(cfg.low_noise_loras);
    expect(high).toEqual([{ path: `https://r2.example/${WAN_HIGH}?sig=X&ttl=${WAN_LORA_PRESIGN_TTL_SECONDS}`, scale: 1.5 }]);
    expect(low).toEqual([{ path: `https://r2.example/${WAN_LOW}?sig=X&ttl=${WAN_LORA_PRESIGN_TTL_SECONDS}`, scale: 1.5 }]);
    expect(WAN_LORA_DEFAULT_SCALE).toBe(1.5);
  });

  it("no-ops for a non-Wan backend (leaves the config untouched)", async () => {
    const cfg: Record<string, unknown> = { fps: 24 };
    const r = await projectWanLorasIntoModuleConfig(anyEnv, "own-gpu", { A: { high: WAN_HIGH, low: WAN_LOW } }, cfg);
    expect(r.applied).toBe(false);
    expect(cfg).toEqual({ fps: 24 });
  });

  it("no-ops for an empty wanPretrained (an SDXL cast), even on the Wan backend", async () => {
    const cfg: Record<string, unknown> = {};
    const r = await projectWanLorasIntoModuleConfig(anyEnv, WAN_LORA_BACKEND, {}, cfg);
    expect(r.applied).toBe(false);
    expect(cfg.high_noise_loras).toBeUndefined();
  });

  it("honors a caller scale override (never silently 1.0)", async () => {
    const cfg: Record<string, unknown> = {};
    await projectWanLorasIntoModuleConfig(anyEnv, WAN_LORA_BACKEND, { A: { high: WAN_HIGH, low: WAN_LOW } }, cfg, 2.0);
    expect(parseLoras(cfg.high_noise_loras)[0].scale).toBe(2.0);
  });

  it("caps at MAX_LORAS_PER_PASS and LOGS the dropped overflow (never silent truncation)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const many: Record<string, { high: string; low: string }> = {};
    for (let i = 0; i < MAX_LORAS_PER_PASS + 2; i++) many[`slot${i}`] = { high: `loras/h${i}`, low: `loras/l${i}` };
    const cfg: Record<string, unknown> = {};
    const r = await projectWanLorasIntoModuleConfig(anyEnv, WAN_LORA_BACKEND, many, cfg);
    expect(r.injected).toBe(MAX_LORAS_PER_PASS);
    expect(r.dropped).toBe(2);
    expect(parseLoras(cfg.high_noise_loras)).toHaveLength(MAX_LORAS_PER_PASS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped 2"));
    warn.mockRestore();
  });

  it("accumulates AFTER a caller-supplied LoRA list (never clobbers it)", async () => {
    const cfg: Record<string, unknown> = {
      high_noise_loras: JSON.stringify([{ path: "https://hf.co/user-lora", scale: 1 }]),
      low_noise_loras: JSON.stringify([{ path: "https://hf.co/user-lora-low", scale: 1 }]),
    };
    await projectWanLorasIntoModuleConfig(anyEnv, WAN_LORA_BACKEND, { A: { high: WAN_HIGH, low: WAN_LOW } }, cfg);
    const high = parseLoras(cfg.high_noise_loras);
    expect(high).toHaveLength(2);
    expect(high[0]).toEqual({ path: "https://hf.co/user-lora", scale: 1 });
    expect(high[1].path).toContain(WAN_HIGH);
  });
});

describe("shouldProjectWanLoras / ensureModuleOverrideConfig -- the gating primitives", () => {
  it("gates on backend AND non-empty wanPretrained", () => {
    expect(shouldProjectWanLoras(WAN_LORA_BACKEND, { A: {} })).toBe(true);
    expect(shouldProjectWanLoras(WAN_LORA_BACKEND, {})).toBe(false);
    expect(shouldProjectWanLoras("own-gpu", { A: {} })).toBe(false);
    expect(shouldProjectWanLoras(undefined, { A: {} })).toBe(false);
  });
  it("creates the nested module config when render_overrides is absent", () => {
    const r = ensureModuleOverrideConfig(undefined, WAN_LORA_BACKEND);
    expect(r.overrides.config).toEqual({ [WAN_LORA_BACKEND]: {} });
    r.config.high_noise_loras = "x";
    expect((r.overrides.config as Record<string, Record<string, unknown>>)[WAN_LORA_BACKEND].high_noise_loras).toBe("x");
  });
  it("preserves an existing module config object (mutates in place)", () => {
    const overrides = { config: { [WAN_LORA_BACKEND]: { seed: 7 } } };
    const r = ensureModuleOverrideConfig(overrides, WAN_LORA_BACKEND);
    expect(r.config.seed).toBe(7);
    expect(r.overrides).toBe(overrides);
  });
});

// ==================================================================================================
describe("cross-wire control at ALL THREE render paths (Wan cast vs SDXL cast, both directions)", () => {
  it("RENDER: a Wan cast projects ONLY high/low_noise_loras at 1.5, NEVER pretrained_loras", async () => {
    const res = await worker.fetch(post("/api/storyboard/render", { bundleKey: "bundles/x.tar.gz", scenes: SCENES, motion_backend: WAN_LORA_BACKEND, castLoras: { A: "wan" } }), env(), ctx);
    expect(res.status).toBe(201);
    const args = cap.film[0];
    const mc = args.motion_config as Record<string, unknown>;
    expect(parseLoras(mc.high_noise_loras)).toEqual([{ path: `https://r2.example/${WAN_HIGH}?sig=X&ttl=${WAN_LORA_PRESIGN_TTL_SECONDS}`, scale: 1.5 }]);
    expect(parseLoras(mc.low_noise_loras)[0].path).toContain(WAN_LOW);
    expect(args.pretrained_loras).toBeUndefined();
  });
  it("RENDER: an SDXL cast projects ONLY pretrained_loras, NEVER the Wan fields (same Wan backend)", async () => {
    const res = await worker.fetch(post("/api/storyboard/render", { bundleKey: "bundles/x.tar.gz", scenes: SCENES, motion_backend: WAN_LORA_BACKEND, castLoras: { A: "sdxl" } }), env(), ctx);
    expect(res.status).toBe(201);
    const args = cap.film[0];
    expect(args.pretrained_loras).toEqual({ A: SDXL_KEY });
    const mc = args.motion_config as Record<string, unknown>;
    expect(mc.high_noise_loras).toBe("[]");
    expect(mc.low_noise_loras).toBe("[]");
  });

  it("FILM: a Wan cast projects ONLY the Wan fields, NEVER pretrained_loras", async () => {
    const res = await worker.fetch(post("/api/render/film", { bundle_key: "bundles/x.tar.gz", scenes: SCENES, motion_backend: WAN_LORA_BACKEND, cast_loras: { A: "wan" } }), env(), ctx);
    expect(res.status).toBe(201);
    const args = cap.film[0];
    const mc = args.motion_config as Record<string, unknown>;
    expect(parseLoras(mc.high_noise_loras)[0].path).toContain(WAN_HIGH);
    expect(parseLoras(mc.low_noise_loras)[0].scale).toBe(1.5);
    expect(args.pretrained_loras).toBeUndefined();
  });
  it("FILM: an SDXL cast projects ONLY pretrained_loras, NEVER the Wan fields", async () => {
    const res = await worker.fetch(post("/api/render/film", { bundle_key: "bundles/x.tar.gz", scenes: SCENES, motion_backend: WAN_LORA_BACKEND, cast_loras: { A: "sdxl" } }), env(), ctx);
    expect(res.status).toBe(201);
    const args = cap.film[0];
    expect(args.pretrained_loras).toEqual({ A: SDXL_KEY });
    const mc = (args.motion_config ?? {}) as Record<string, unknown>;
    expect(mc.high_noise_loras).toBeUndefined();
  });

  it("SCATTER: a Wan cast injects the Wan fields into render_overrides.config so every shard gets them", async () => {
    const res = await worker.fetch(post("/api/storyboard/render/scatter", { bundleKey: "bundles/x.tar.gz", shotIds: ["shot_01", "shot_02"], motion_backend: WAN_LORA_BACKEND, castLoras: { A: "wan" } }), env(), ctx);
    expect(res.status).toBe(201);
    const args = cap.scatter[0];
    const ro = args.render_overrides as { config?: Record<string, Record<string, unknown>> };
    const wcfg = ro.config?.[WAN_LORA_BACKEND] ?? {};
    expect(parseLoras(wcfg.high_noise_loras)[0].path).toContain(WAN_HIGH);
    expect(parseLoras(wcfg.low_noise_loras)[0].scale).toBe(1.5);
  });
  it("SCATTER: an SDXL cast injects NO Wan fields (render_overrides stays free of the Wan config)", async () => {
    const res = await worker.fetch(post("/api/storyboard/render/scatter", { bundleKey: "bundles/x.tar.gz", shotIds: ["shot_01", "shot_02"], motion_backend: WAN_LORA_BACKEND, castLoras: { A: "sdxl" } }), env(), ctx);
    expect(res.status).toBe(201);
    const args = cap.scatter[0];
    const ro = (args.render_overrides ?? undefined) as { config?: Record<string, Record<string, unknown>> } | undefined;
    const wcfg = ro?.config?.[WAN_LORA_BACKEND];
    expect(wcfg?.high_noise_loras).toBeUndefined();
  });
});

// ==================================================================================================
describe("POST /api/cast/:id/train-wan-lora route", () => {
  const PUBLIC_ID = "12345678-1234-4123-8123-1234567890ab";
  it("dispatches to handleCastTrainWanLora with the resolved cast id", async () => {
    const res = await worker.fetch(post(`/api/cast/${PUBLIC_ID}/train-wan-lora`, {}), env(), ctx);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { via?: string };
    expect(body.via).toBe("wan-train-handler");
    expect(cap.wanTrainId).toBe(5);
  });
  it("is a rate-limited spend route (GPU training)", () => {
    expect(isSpendRoute("POST", "/api/cast/7/train-wan-lora")).toBe(true);
    expect(isSpendRoute("GET", "/api/cast/7/train-wan-lora")).toBe(false);
  });
});
