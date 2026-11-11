import { describe, it, expect, vi } from "vitest";

// vivijure-cf#1391: the agent door (POST /api/render/film: vivijure-mcp submit_film, Slate, every part of a
// long film) carries no overrides bag, so before this a caller there could not pick the dialogue module.
// The door now takes dialogue_backend and dialogue_config, refuses an unserved name or key by name before
// any spend, clamps each map through the module's schema, and forwards both to startFilmJob. A long film
// sends one shared choice to every part. Which module the dialogue tick then calls is core's (core#339).

const h = vi.hoisted(() => ({ lastArgs: {} as Record<string, unknown>, started: 0 }));
vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: { scenes?: unknown }) => {
      h.lastArgs = args;
      h.started++;
      return { film_id: "film-1391-test", project: "p", phase: "keyframe", scenes: args.scenes, created_at: 0 };
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

import worker from "../src/index";
import { buildParentDoc, partInputs, type CreateParentBody } from "../src/film-parent";
import { resolveAgentDialogue } from "../src/render-door";
import { MODULE_API, type RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const manifestFetcher = (manifest: unknown) => ({
  fetch: async () => new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } }),
});

// The shipped dialogue names and ui.order (dialogue-gen 5, chatterbox 10). chatterbox gets a fixture knob.
const GEN = { name: "dialogue-gen", version: "1.0.0", api: MODULE_API, hooks: ["dialogue"], ui: { order: 5 } };
const CHATTER = {
  name: "chatterbox", version: "1.0.0", api: MODULE_API, hooks: ["dialogue"], ui: { order: 10 },
  config_schema: { exaggeration: { type: "float", default: 0.5, min: 0, max: 2, label: "exaggeration" } },
};
const KF = { name: "cloud-keyframe", version: "0.1.0", api: MODULE_API, hooks: ["keyframe"] };
const SEEDANCE = { name: "seedance", version: "0.2.2", api: MODULE_API, hooks: ["motion.backend"], ui: { order: 10, locality: "cloud" } };

function env(): Env {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET") },
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    MODULE_KEYFRAME: manifestFetcher(KF),
    MODULE_SEEDANCE: manifestFetcher(SEEDANCE),
    MODULE_DIALOGUE_GEN: manifestFetcher(GEN),
    MODULE_CHATTERBOX: manifestFetcher(CHATTER),
  } as unknown as Env;
}
const post = (path: string, body: unknown) => new Request(`https://studio.example${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const SCENES = [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }];
const submit = (extra: Record<string, unknown>) => worker.fetch(
  post("/api/render/film", { bundle_key: "bundles/verify.tar.gz", scenes: SCENES, motion_backend: "seedance", ...extra }),
  env(), ctx,
);

describe("POST /api/render/film forwards the dialogue choice (cf#1391)", () => {
  it("CONTROL: the fixture modules are discovered (a known-good submit starts a film)", async () => {
    h.started = 0;
    const res = await submit({});
    expect(res.status).toBe(201);
    expect(h.started).toBe(1);
  });

  it("forwards dialogue_backend and the clamped dialogue_config", async () => {
    h.started = 0;
    const res = await submit({ dialogue_backend: "chatterbox", dialogue_config: { chatterbox: { exaggeration: 0.9 } } });
    expect(res.status).toBe(201);
    expect(h.started).toBe(1);
    expect(h.lastArgs.dialogue_backend).toBe("chatterbox");
    expect(h.lastArgs.dialogue_config).toEqual({ chatterbox: { exaggeration: 0.9 } });
  });

  it("with no choice nothing is sent, so the first dialogue module by ui.order runs", async () => {
    const res = await submit({});
    expect(res.status).toBe(201);
    expect("dialogue_backend" in h.lastArgs).toBe(false);
    expect("dialogue_config" in h.lastArgs).toBe(false);
  });

  const refusals: [string, Record<string, unknown>, RegExp][] = [
    ["an uninstalled module", { dialogue_backend: "elevenlabs" }, /"elevenlabs" is not installed/],
    ["a module that does not serve dialogue", { dialogue_backend: "seedance" }, /"seedance" does not serve the dialogue hook/],
    ["a blank name", { dialogue_backend: " " }, /dialogue_backend must be a non-empty string/],
    ["a non-string name", { dialogue_backend: 7 }, /dialogue_backend must be a non-empty string/],
    ["a config key that names no dialogue module", { dialogue_config: { seedance: {} } }, /dialogue_config names "seedance"/],
    ["an out-of-range knob", { dialogue_config: { chatterbox: { exaggeration: 9 } } }, /rejected by "chatterbox".*out of range/],
    ["an unknown knob", { dialogue_config: { chatterbox: { exagerate: 1 } } }, /unknown key "exagerate"/],
    ["a non-object map", { dialogue_config: "chatterbox" }, /dialogue_config must be a JSON object/],
    ["a non-object module entry", { dialogue_config: { chatterbox: 1 } }, /dialogue_config\.chatterbox must be a JSON object/],
  ];
  for (const [label, extra, msg] of refusals) {
    it(`refuses ${label} by name, before any job`, async () => {
      h.started = 0;
      const res = await submit(extra);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toMatch(msg);
      expect(h.started).toBe(0);
    });
  }
});

describe("resolveAgentDialogue", () => {
  const mods = [GEN, CHATTER, SEEDANCE] as unknown as RegisteredModule[];
  it("fills schema defaults on a partial map, as the panel resolver does", () => {
    expect(resolveAgentDialogue(mods, undefined, { chatterbox: {} })).toEqual({ ok: true, dialogue_config: { chatterbox: { exaggeration: 0.5 } } });
  });
  it("trims the name it forwards", () => {
    expect(resolveAgentDialogue(mods, " chatterbox ", undefined)).toEqual({ ok: true, dialogue_backend: "chatterbox" });
  });
});

function parentBody(shared: Record<string, unknown>): CreateParentBody {
  return {
    project: "Long",
    storyboard: { title: "t", scenes: Array.from({ length: 4 }, (_, i) => ({ shot_id: `s${i}`, prompt: `p${i}`, seconds: 4 })) },
    character_refs: { A: { key: "a" } },
    part_size: 2,
    shared: { motion_backend: "seedance", style: "photoreal", delivery_width: 1920, delivery_height: 1080, ...shared },
    spend_ceiling_usd: 1000,
    cost_usd_per_shot_est: 1,
    pause_after_first_part: false,
    idempotency_key: "k-1391",
  } as unknown as CreateParentBody;
}

describe("a long film sends one dialogue choice to every part (cf#1391)", () => {
  it("every part submit carries shared.dialogue_backend and shared.dialogue_config", () => {
    const doc = buildParentDoc("feature-1391", parentBody({ dialogue_backend: "chatterbox", dialogue_config: { chatterbox: { exaggeration: 1 } } }), 0);
    expect(doc.parts.length).toBe(2);
    for (const part of doc.parts) {
      const { submit } = partInputs(doc, part);
      expect(submit.dialogue_backend).toBe("chatterbox");
      expect(submit.dialogue_config).toEqual({ chatterbox: { exaggeration: 1 } });
    }
  });

  it("CONTROL: with no shared choice no part carries one", () => {
    const doc = buildParentDoc("feature-1391", parentBody({}), 0);
    const { submit } = partInputs(doc, doc.parts[0]);
    expect("dialogue_backend" in submit).toBe(false);
    expect("dialogue_config" in submit).toBe(false);
  });

  for (const [label, shared, msg] of [
    ["a blank name", { dialogue_backend: "" }, /shared\.dialogue_backend/],
    ["a non-map config", { dialogue_config: [] }, /shared\.dialogue_config/],
    ["a non-object module entry", { dialogue_config: { chatterbox: 1 } }, /shared\.dialogue_config/],
  ] as [string, Record<string, unknown>, RegExp][]) {
    it(`the parent refuses ${label}`, () => {
      expect(() => buildParentDoc("feature-1391", parentBody(shared), 0)).toThrow(msg);
    });
  }

  it("POST /api/film refuses a dialogue module this studio does not serve, before the film is stored", async () => {
    const res = await worker.fetch(post("/api/film", parentBody({ dialogue_backend: "elevenlabs" })), env(), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/shared\.dialogue module "elevenlabs" is not installed/);
  });
});
