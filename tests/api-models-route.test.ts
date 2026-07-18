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

// Deliberately NOT named "image-generate": nothing in the projection or dispatch may special-case a
// module NAME, and a fixture borrowing the first-party name would hide it if something did.
const IMAGE_MODEL_IDS = ["acme/img-xl", "acme/img-mini"];
const imager: RegisteredModule = {
  name: "acme-imagegen",
  version: "1.0.0",
  api: MODULE_API,
  hooks: ["image.generate"],
  provides: [{ id: "acme-img", label: "ACME Image" }],
  binding: "MODULE_ACMEIMAGEGEN",
  config_schema: {
    model: { type: "enum", values: IMAGE_MODEL_IDS, default: IMAGE_MODEL_IDS[0], label: "image model" },
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

  it("serves PROJECTED planning rows and PROJECTED image rows together", async () => {
    const { body } = await getModels(envWith({
      MODULE_ACMEPLANNER: moduleWorker(planner),
      MODULE_ACMEIMAGEGEN: moduleWorker(imager),
    }));
    const ids = body.models.map((m) => m.id);
    expect(ids).toContain("acme/planner-xl");
    expect(ids).toContain("acme/planner-mini");
    // The image ids come from the MODULE manifest, not from any list in this repo. That is the
    // whole point of phase 2: grep the studio for these ids and you will not find them.
    for (const id of IMAGE_MODEL_IDS) expect(ids).toContain(id);
  });

  // The empty-suite control: with modules installed, real rows of BOTH kinds come back. Without it
  // the honest-empty assertions would also pass on a totally broken route.
  it("control: both projections yield real rows when modules ARE installed", async () => {
    const { body } = await getModels(envWith({
      MODULE_ACMEPLANNER: moduleWorker(planner),
      MODULE_ACMEIMAGEGEN: moduleWorker(imager),
    }));
    expect(body.models.filter((m) => m.type === "chat").length).toBeGreaterThan(0);
    expect(body.models.filter((m) => m.type === "image").length).toBe(IMAGE_MODEL_IDS.length);
  });

  it("omits IMAGE rows entirely when no image.generate module is installed", async () => {
    const { res, body } = await getModels(envWith({ MODULE_ACMEPLANNER: moduleWorker(planner) }));
    expect(res.status).toBe(200);
    expect(body.models.filter((m) => m.type === "image")).toEqual([]);
  });

  it("carries both types so the panel can filter on row.type", async () => {
    const { body } = await getModels(envWith({
      MODULE_ACMEPLANNER: moduleWorker(planner),
      MODULE_ACMEIMAGEGEN: moduleWorker(imager),
    }));
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
  // cf#129 phase 2 changed what "nothing installed" means: the image rows are a PROJECTION now, so
  // with no modules at all BOTH halves are legitimately empty. The empty-suite control moves to the
  // module-installed case, where real rows of both kinds must come back.
  it("is honestly EMPTY when no module of either kind is installed", async () => {
    const { res, body } = await getModels(envWith());
    expect(res.status).toBe(200);
    expect(body.models).toEqual([]);
  });

  // Row shape is SHARED with /api/storyboard/models, with vivijure-local, and with the panel. A
  // field added or renamed on one side breaks here rather than silently in a picker.
  it("every row carries exactly the shared key set, whatever its origin", async () => {
    const { body } = await getModels(envWith({
      MODULE_ACMEPLANNER: moduleWorker(planner),
      MODULE_ACMEIMAGEGEN: moduleWorker(imager),
    }));
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
