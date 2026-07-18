// GET /api/models -- the canonical full catalog on both hosts (cf#129).
//
// This route is the JOINT PIN with the panel lane: the envelope and the row shape asserted here are
// what the pickers render against. cf#129 phase 2 swaps the image rows from a hardcoded list to a
// module projection, and that swap must be INVISIBLE to every consumer -- so the assertions below
// are deliberately written against the envelope and row keys, never against the row COUNT or a
// specific hardcoded id set that phase 2 would legitimately change.

import { describe, expect, it, beforeEach } from "vitest";
import { MODULE_API, type RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import worker from "../src/index";
import type { Env } from "../src/env";
import { IMAGE_MODELS } from "../src/image-models";

const planner: RegisteredModule = {
  name: "acme-planner",
  version: "3.1.0",
  api: MODULE_API,
  hooks: ["plan.enhance"],
  provides: [{ id: "acme", label: "ACME Planning" }],
  binding: "MODULE_ACMEPLANNER",
  config_schema: {
    model: {
      type: "enum",
      values: ["acme/planner-xl", "acme/planner-mini"],
      default: "acme/planner-xl",
      label: "model",
    },
  },
};

function moduleWorker(manifest: RegisteredModule) {
  return {
    fetch: async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === "/module.json") {
        return new Response(JSON.stringify(manifest), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404 });
    },
  };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function envWith(bindings: Record<string, unknown> = {}) {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    ...bindings,
  } as unknown as Env;
}

async function getModels(env: Env) {
  const res = await worker.fetch(new Request("https://studio.example/api/models"), env, ctx);
  return { res, body: (await res.json()) as { models: Array<Record<string, unknown>> } };
}

describe("GET /api/models", () => {
  beforeEach(() => {
    _resetModuleDiscoveryCache();
  });

  it("exists and serves the {models:[...]} envelope", async () => {
    const { res, body } = await getModels(envWith());
    expect(res.status).toBe(200);
    expect(Array.isArray(body.models)).toBe(true);
  });

  it("serves the image rows and the PROJECTED planning rows together", async () => {
    const { body } = await getModels(envWith({ MODULE_ACMEPLANNER: moduleWorker(planner) }));
    const ids = body.models.map((m) => m.id);
    // projected from the installed module, not hardcoded anywhere in the studio
    expect(ids).toContain("acme/planner-xl");
    expect(ids).toContain("acme/planner-mini");
    // image rows present alongside them
    expect(ids).toContain("google/nano-banana-pro");
  });

  it("carries both types so the panel can filter on row.type", async () => {
    const { body } = await getModels(envWith({ MODULE_ACMEPLANNER: moduleWorker(planner) }));
    const types = new Set(body.models.map((m) => m.type));
    expect(types.has("chat")).toBe(true);
    expect(types.has("image")).toBe(true);
  });

  // THE HONEST-FAIL PIN (Joan's non-negotiable, and cf#135's failure mode).
  // With nothing installed, the planning rows must be ABSENT -- 200 with a short list, never a 404,
  // and never a hardcoded planning backfill standing in for an uninstalled module.
  it("omits planning rows entirely when NO plan.enhance module is installed", async () => {
    const { res, body } = await getModels(envWith());
    expect(res.status).toBe(200);
    const chatRows = body.models.filter((m) => m.type === "chat");
    expect(chatRows).toEqual([]);
  });

  // The negative control for the assertion above. Without this, "no chat rows" would also pass if
  // the route were broken and returned nothing at all -- the empty-suite trap. This proves the
  // route still serves real rows in the same call where the chat rows are absent.
  it("still serves the image rows in that same no-module case (empty-suite control)", async () => {
    const { body } = await getModels(envWith());
    const imageRows = body.models.filter((m) => m.type === "image");
    expect(imageRows.length).toBe(IMAGE_MODELS.length);
    expect(imageRows.length).toBeGreaterThan(0);
  });

  // Row shape is SHARED with /api/storyboard/models, with vivijure-local, and with the panel. A
  // field added or renamed on one side breaks here rather than silently in a picker.
  it("every row carries exactly the shared key set, whatever its origin", async () => {
    const { body } = await getModels(envWith({ MODULE_ACMEPLANNER: moduleWorker(planner) }));
    const allowed = ["capabilities", "group", "id", "label", "provider", "type"];
    const required = ["id", "label", "group", "type", "capabilities"];
    expect(body.models.length).toBeGreaterThan(0);
    for (const row of body.models) {
      const keys = Object.keys(row);
      expect(keys.filter((k) => !allowed.includes(k))).toEqual([]);
      expect(keys).toEqual(expect.arrayContaining(required));
    }
  });

  // /api/storyboard/models is a FILTERED VIEW of this same projection, not a second catalog. If the
  // two ever diverge, the MCP storyboard_models tool and the panel disagree about what exists.
  it("agrees with /api/storyboard/models on the planning rows", async () => {
    const env = envWith({ MODULE_ACMEPLANNER: moduleWorker(planner) });
    const { body: all } = await getModels(env);
    _resetModuleDiscoveryCache();
    const sres = await worker.fetch(
      new Request("https://studio.example/api/storyboard/models"),
      env,
      ctx,
    );
    const sbody = (await sres.json()) as { models: Array<{ id: string }> };
    const chatIds = all.models.filter((m) => m.type === "chat").map((m) => m.id).sort();
    expect(sbody.models.map((m) => m.id).sort()).toEqual(chatIds);
  });
});
