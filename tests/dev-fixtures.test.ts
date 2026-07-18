// The cf#62 parity-gate fixture modules are CONTRACT-VALID (dev harness, .dev-modbound/fixtures).
//
// Why this is a real test and not throwaway scaffolding: readManifest SKIPS a module whose manifest
// fails validation, logging a console.warn and returning null. A fixture with a subtly bad manifest
// would therefore vanish from the catalog silently, and the parity gate would show an empty or
// short picker that looks exactly like a backend defect. That is a "reads safe but isn't" trap
// aimed straight at the gate this sprint closes on, so the fixtures get the same conformance bar as
// a shipped module.

import { describe, expect, it, beforeEach } from "vitest";
import { checkManifest, allPass, failures } from "@skyphusion-labs/vivijure-core/modules/conformance";
import { discoverModules, _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import { planningModelsFromModules, resolvePlanningTarget } from "../src/planning-models";

import acme from "../.dev-modbound/fixtures/acme-planner.mjs";
import bespoke from "../.dev-modbound/fixtures/bespoke-planner.mjs";
import legacy from "../.dev-modbound/fixtures/legacy-planner.mjs";

const FIXTURES = [
  { name: "acme-planner", worker: acme },
  { name: "bespoke-planner", worker: bespoke },
  { name: "legacy-planner", worker: legacy },
];

/** Adapt a fixture worker to the service-binding fetcher contract (urlString, init). */
function binding(worker: { fetch: (r: Request) => Promise<Response> }) {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
      worker.fetch(new Request(String(input), init as RequestInit)),
  };
}

async function manifestOf(worker: { fetch: (r: Request) => Promise<Response> }) {
  const res = await worker.fetch(new Request("https://module/module.json"));
  expect(res.status).toBe(200);
  return await res.json();
}

describe("dev fixture modules are contract-valid", () => {
  for (const { name, worker } of FIXTURES) {
    it(`${name} serves a conforming manifest`, async () => {
      const checks = checkManifest(await manifestOf(worker));
      expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
    });

    it(`${name} is DISCOVERABLE (would not be silently skipped)`, async () => {
      _resetModuleDiscoveryCache();
      const mods = await discoverModules({ [`MODULE_${name.replace(/-/g, "").toUpperCase()}`]: binding(worker) });
      expect(mods.map((m) => m.name)).toContain(name);
    });
  }
});

describe("dev fixture scenarios project the catalog the gate expects", () => {
  beforeEach(() => _resetModuleDiscoveryCache());

  it("thirdparty: acme contributes its enum, bespoke contributes its module name", async () => {
    const mods = await discoverModules({
      MODULE_ACMEPLANNER: binding(acme),
      MODULE_BESPOKEPLANNER: binding(bespoke),
    });
    const ids = planningModelsFromModules(mods).map((m) => m.id);
    expect(ids).toContain("acme/planner-xl");
    expect(ids).toContain("acme/planner-mini");
    // the no-enum module appears under its own NAME as the id -- the byName branch Joan drives
    expect(ids).toContain("bespoke-planner");
  });

  it("bespoke-planner's module-name id resolves back to it", async () => {
    const mods = await discoverModules({
      MODULE_ACMEPLANNER: binding(acme),
      MODULE_BESPOKEPLANNER: binding(bespoke),
    });
    const target = resolvePlanningTarget(mods, "bespoke-planner");
    expect(target?.moduleName).toBe("bespoke-planner");
    expect(target?.configModel).toBeUndefined();
  });

  it("staleid: legacy ids exist WITH legacy bound and are absent without it", async () => {
    const withLegacy = await discoverModules({
      MODULE_ACMEPLANNER: binding(acme),
      MODULE_LEGACYPLANNER: binding(legacy),
    });
    expect(planningModelsFromModules(withLegacy).map((m) => m.id)).toContain("legacy/model-going-away");

    _resetModuleDiscoveryCache();
    const withoutLegacy = await discoverModules({ MODULE_ACMEPLANNER: binding(acme) });
    const ids = planningModelsFromModules(withoutLegacy).map((m) => m.id);
    // This is the stale-id premise: the saved id is REALLY gone, not merely filtered.
    expect(ids).not.toContain("legacy/model-going-away");
    expect(resolvePlanningTarget(withoutLegacy, "legacy/model-going-away")?.moduleName).toBe("acme-planner");
  });

  it("empty: no plan.enhance module bound -> empty catalog", async () => {
    const mods = await discoverModules({});
    expect(planningModelsFromModules(mods)).toEqual([]);
  });
});

describe("dev fixture modules answer the hook honestly", () => {
  it("plan mode returns a storyboard naming the answering module and model", async () => {
    const res = await acme.fetch(
      new Request("https://module/invoke", {
        method: "POST",
        body: JSON.stringify({
          hook: "plan.enhance",
          input: { storyboard: { scenes: [] } },
          config: { mode: "plan", model: "acme/planner-xl", message: "a harbor film" },
          context: { project: "p", job_id: "j" },
        }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; output: { storyboard: { title: string } } };
    expect(body.ok).toBe(true);
    expect(body.output.storyboard.title).toContain("acme-planner");
    expect(body.output.storyboard.title).toContain("acme/planner-xl");
  });

  it("rejects a missing config.message rather than inventing a plan", async () => {
    const res = await acme.fetch(
      new Request("https://module/invoke", {
        method: "POST",
        body: JSON.stringify({
          hook: "plan.enhance",
          input: { storyboard: { scenes: [] } },
          config: { mode: "plan", model: "acme/planner-xl" },
          context: { project: "p", job_id: "j" },
        }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("config.message required");
  });
});
