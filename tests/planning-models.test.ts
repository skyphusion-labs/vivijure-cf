// The planning catalog is PROJECTED from installed plan.enhance modules (cf#62).
//
// The binding acceptance criterion for the port (Conrad, via the issue): a THIRD-PARTY-shaped
// plan.enhance module installed alongside ours must have its models appear in
// GET /api/storyboard/models and must be ROUTED TO -- with no special-casing of the "plan-enhance"
// module name anywhere. "Appears in the list" is the cheap half; the half that actually proves the
// contract is that a third-party id dispatches to the THIRD-PARTY worker, so the routing tests below
// assert which binding got the /invoke call, not merely that the call succeeded.

import { describe, expect, it, beforeEach } from "vitest";
import { MODULE_API, type RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import {
  planningModelsFromModules,
  resolvePlanningTarget,
  findPlanningModel,
} from "../src/planning-models";
import { planStoryboard, chatComplete } from "../src/planner";
import worker from "../src/index";
import type { Env } from "../src/env";

// ---------------------------------------------------------------- fixtures

/** Our module, as its manifest actually ships (modules/plan-enhance/src/index.ts). */
const ours: RegisteredModule = {
  name: "plan-enhance",
  version: "0.2.1",
  api: MODULE_API,
  hooks: ["plan.enhance"],
  provides: [{ id: "auto-direction", label: "Opus auto-direction" }],
  binding: "MODULE_PLANENHANCE",
  config_schema: {
    model: {
      type: "enum",
      values: [
        "anthropic/claude-opus-4-8",
        "anthropic/claude-opus-4-7",
        "anthropic/claude-sonnet-5",
        "anthropic/claude-sonnet-4-6",
      ],
      default: "anthropic/claude-opus-4-8",
      label: "model",
    },
  },
};

/** A third-party planning module: different vendor, different models, nothing to do with us. */
const thirdParty: RegisteredModule = {
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

/** A planning module that declares NO model enum -- it still has to be selectable, under its name. */
const noEnum: RegisteredModule = {
  name: "bespoke-planner",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["plan.enhance"],
  provides: [{ id: "bespoke", label: "Bespoke Planner" }],
  binding: "MODULE_BESPOKEPLANNER",
};

/** A module that does NOT serve plan.enhance -- it must never reach the planning catalog. */
const unrelated: RegisteredModule = {
  name: "finish-rife",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["finish"],
  binding: "MODULE_FINISHRIFE",
  config_schema: {
    model: { type: "enum", values: ["rife/v4.6"], default: "rife/v4.6", label: "model" },
  },
};

// ---------------------------------------------------------------- projection

describe("planningModelsFromModules", () => {
  it("derives the catalog from a plan.enhance module's config_schema.model enum", () => {
    expect(planningModelsFromModules([ours]).map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("carries claude-sonnet-5 -- the id the retracted phase-1 plan would have hardcoded", () => {
    expect(planningModelsFromModules([ours]).map((m) => m.id)).toContain("anthropic/claude-sonnet-5");
  });

  it("lists a module with NO model enum under its own name/label", () => {
    const rows = planningModelsFromModules([noEnum]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "bespoke-planner",
      label: "Bespoke Planner",
      group: "Planning · bespoke-planner",
      module: "bespoke-planner",
    });
  });

  it("ignores modules that do not serve plan.enhance, model enum or not", () => {
    expect(planningModelsFromModules([unrelated])).toEqual([]);
    expect(planningModelsFromModules([unrelated, ours]).every((m) => m.module === "plan-enhance")).toBe(true);
  });

  it("serves an EMPTY catalog when no planning module is installed (a legitimate answer)", () => {
    expect(planningModelsFromModules([])).toEqual([]);
  });

  it("tags every row with the module that declared it", () => {
    const rows = planningModelsFromModules([ours, thirdParty]);
    expect(rows.find((m) => m.id === "acme/planner-xl")?.module).toBe("acme-planner");
    expect(rows.find((m) => m.id === "anthropic/claude-sonnet-5")?.module).toBe("plan-enhance");
  });

  // ACCEPTANCE CRITERION (projection half).
  it("lists a third-party module's models alongside ours, with no special-casing", () => {
    const ids = planningModelsFromModules([ours, thirdParty]).map((m) => m.id);
    expect(ids).toContain("acme/planner-xl");
    expect(ids).toContain("acme/planner-mini");
    expect(ids).toContain("anthropic/claude-opus-4-8");
  });

  it("gives the third-party module the same row shape ours gets", () => {
    const row = planningModelsFromModules([thirdParty]).find((m) => m.id === "acme/planner-xl");
    expect(row).toMatchObject({
      id: "acme/planner-xl",
      label: "ACME Planning · acme/planner-xl",
      group: "Planning · acme-planner",
      type: "chat",
      capabilities: [],
      module: "acme-planner",
    });
  });
});

// ---------------------------------------------------------------- resolution

describe("resolvePlanningTarget", () => {
  it("routes a model id back to the module that declared it", () => {
    expect(resolvePlanningTarget([ours, thirdParty], "anthropic/claude-opus-4-8")).toEqual({
      moduleName: "plan-enhance",
      modelId: "anthropic/claude-opus-4-8",
      configModel: "anthropic/claude-opus-4-8",
    });
  });

  // ACCEPTANCE CRITERION (resolution half).
  it("routes a THIRD-PARTY model id to the third-party module, not ours", () => {
    const target = resolvePlanningTarget([ours, thirdParty], "acme/planner-xl");
    expect(target?.moduleName).toBe("acme-planner");
    expect(target?.configModel).toBe("acme/planner-xl");
  });

  it("routes by module name when the module declares no enum", () => {
    const target = resolvePlanningTarget([ours, noEnum], "bespoke-planner");
    expect(target?.moduleName).toBe("bespoke-planner");
    expect(target?.configModel).toBeUndefined();
  });

  it("returns null for an unknown id when several modules are installed (no guessing)", () => {
    expect(resolvePlanningTarget([ours, thirdParty], "who/knows")).toBeNull();
  });

  it("falls back to the sole installed module for an unknown id", () => {
    const target = resolvePlanningTarget([thirdParty], "who/knows");
    expect(target?.moduleName).toBe("acme-planner");
    expect(target?.configModel).toBe("acme/planner-xl");
  });

  it("returns null with nothing installed, and on a blank id", () => {
    expect(resolvePlanningTarget([], "anthropic/claude-opus-4-8")).toBeNull();
    expect(resolvePlanningTarget([ours], "   ")).toBeNull();
  });

  it("does not resolve a model declared by a non-plan.enhance module", () => {
    // Two planning modules installed, so the sole-module fallback is out of the way and this
    // asserts what it claims to: a `finish` module's model enum is not planning inventory.
    expect(resolvePlanningTarget([unrelated, ours, thirdParty], "rife/v4.6")).toBeNull();
  });
});

describe("findPlanningModel", () => {
  it("returns the catalog row for an installed id, undefined otherwise", () => {
    expect(findPlanningModel([ours], "anthropic/claude-sonnet-5")?.module).toBe("plan-enhance");
    expect(findPlanningModel([ours], "acme/planner-xl")).toBeUndefined();
  });
});

// ------------------------------------------------- end-to-end over the wire

/** A stub module worker: serves its manifest on GET /module.json and records every /invoke it gets.
 *
 *  The core's registry calls a service binding as fetch(urlString, init) -- NOT with a Request
 *  object -- so this stub takes the same shape the real fetcher contract uses. */
function fakeModuleWorker(manifest: RegisteredModule, storyboard: unknown) {
  const invocations: Array<Record<string, unknown>> = [];
  return {
    invocations,
    binding: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/module.json") {
          return new Response(JSON.stringify(manifest), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (pathname === "/invoke") {
          invocations.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(
            JSON.stringify({ ok: true, output: { storyboard, notes: [`answered by ${manifest.name}`] } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404 });
      },
    },
  };
}

const VALID_STORYBOARD = {
  title: "Test",
  scenes: [{ prompt: "A wide establishing shot of a quiet harbor at dawn." }],
};

describe("GET /api/storyboard/models -- projected over the wire (acceptance criterion)", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  beforeEach(() => {
    _resetModuleDiscoveryCache();
  });

  function envWithBoth() {
    const mine = fakeModuleWorker(ours, VALID_STORYBOARD);
    const theirs = fakeModuleWorker(thirdParty, VALID_STORYBOARD);
    const env = {
      ALLOW_UNAUTHENTICATED: "true",
      MODULE_PLANENHANCE: mine.binding,
      MODULE_ACMEPLANNER: theirs.binding,
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    } as unknown as Env;
    return { env, mine, theirs };
  }

  it("serves BOTH modules' models, ours and the third party's", async () => {
    const { env } = envWithBoth();
    const res = await worker.fetch(
      new Request("https://studio.example/api/storyboard/models"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string; module: string }> };
    const ids = body.models.map((m) => m.id);
    expect(ids).toContain("anthropic/claude-sonnet-5");
    expect(ids).toContain("acme/planner-xl");
    expect(ids).toContain("acme/planner-mini");
  });

  it("serves an empty catalog when no plan.enhance module is bound", async () => {
    const env = {
      ALLOW_UNAUTHENTICATED: "true",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    } as unknown as Env;
    const res = await worker.fetch(
      new Request("https://studio.example/api/storyboard/models"),
      env,
      ctx,
    );
    expect(await res.json()).toEqual({ models: [] });
  });

  // The half that actually proves routing: the THIRD-PARTY worker gets the call.
  it("dispatches a third-party model id to the THIRD-PARTY module, not ours", async () => {
    const { env, mine, theirs } = envWithBoth();
    const r = await planStoryboard(env, {
      brief: "a short film about a harbor",
      characters: [],
      model: "acme/planner-xl",
    });

    expect(r.ok).toBe(true);
    expect(r.module).toBe("acme-planner");
    expect(theirs.invocations).toHaveLength(1);
    expect(mine.invocations).toHaveLength(0);
    // and it received its OWN catalog id as config.model
    expect(theirs.invocations[0]).toMatchObject({
      hook: "plan.enhance",
      config: { mode: "plan", model: "acme/planner-xl" },
    });
  });

  it("dispatches OUR model id to our module, not the third party's", async () => {
    const { env, mine, theirs } = envWithBoth();
    const r = await planStoryboard(env, {
      brief: "a short film about a harbor",
      characters: [],
      model: "anthropic/claude-sonnet-5",
    });

    expect(r.ok).toBe(true);
    expect(r.module).toBe("plan-enhance");
    expect(mine.invocations).toHaveLength(1);
    expect(theirs.invocations).toHaveLength(0);
    expect(mine.invocations[0]).toMatchObject({
      config: { mode: "plan", model: "anthropic/claude-sonnet-5" },
    });
  });

  it("routes chat mode through the declaring module too", async () => {
    const { env, theirs } = envWithBoth();
    const r = await chatComplete(env, { model: "acme/planner-mini", user_input: "hello" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.module).toBe("acme-planner");
    expect(theirs.invocations[0]).toMatchObject({ config: { mode: "chat", model: "acme/planner-mini" } });
  });

  it("fails honestly when the chosen model has no serving module", async () => {
    const env = {
      ALLOW_UNAUTHENTICATED: "true",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    } as unknown as Env;
    const r = await planStoryboard(env, { brief: "x", characters: [], model: "acme/planner-xl" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("no plan.enhance module serves model");
  });
  // The load-bearing claim behind deleting the Anthropic rows from src/models.ts (cf#62 item 3):
  // /api/chat consults findModel() ONLY to detect an image model, so a text id that is no longer in
  // MODELS still reaches chatComplete -> the plan.enhance module. Asserted over the real route,
  // because "it should fall through" is exactly the kind of assumption that reads safe and isn't.
  it("POST /api/chat still routes an anthropic id to the module after the MODELS rows were deleted", async () => {
    const { env, mine } = envWithBoth();
    const res = await worker.fetch(
      new Request("https://studio.example/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude-sonnet-5", user_input: "hello" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string; model: string };
    expect(body.model).toBe("anthropic/claude-sonnet-5");
    expect(mine.invocations).toHaveLength(1);
    expect(mine.invocations[0]).toMatchObject({ config: { mode: "chat" } });
  });
});

