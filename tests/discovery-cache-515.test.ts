// cf#515 defect 2 acceptance, written RED-FIRST and expected to FAIL against today's code.
//
// The issue specifies this acceptance verbatim:
//   "Cache: drive it red -- count readManifest invocations across two polls inside the TTL and
//    assert the second poll performs zero. That assertion must fail against today's code."
//
// SEAM: readManifest is not injectable, so this counts the thing readManifest actually does --
// one `fetch("https://module/module.json")` per bound MODULE_* binding. That is one level CLOSER
// to the artifact than a stub of readManifest would be, and it cannot be satisfied by a stub.
//
// The counter and its denominator print in the SAME assertions as the claim (N120/N318): if the
// first discovery issues zero fetches the fixture is dead and the "second poll issued zero" result
// would be a HARNESS PASS, not a verdict.
import { describe, it, expect, beforeEach } from "vitest";
import {
  discoverModules,
  _resetModuleDiscoveryCache,
} from "@skyphusion-labs/vivijure-core/modules/registry";
import { MODULE_API, type ModuleManifest } from "@skyphusion-labs/vivijure-core/modules/types";


const manifest = (name: string): ModuleManifest => ({
  name,
  version: "1.0.0",
  api: MODULE_API,
  hooks: ["plan.enhance"],
});

/** A MODULE_* service binding that COUNTS every manifest read it serves. */
function countingModule(name: string, counter: { manifestReads: number }) {
  return {
    async fetch(input: Request | string): Promise<Response> {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/module.json")) {
        counter.manifestReads++;
        return new Response(JSON.stringify(manifest(name)), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

function envWithModules(n: number, counter: { manifestReads: number }) {
  const env: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) env[`MODULE_M${i}`] = countingModule(`m${i}`, counter);
  return env;
}

const BOUND_MODULES = 27; // the live catalogue size quoted in cf#515

describe("cf#515 defect 2 -- discoverModules cache default", () => {
  beforeEach(() => _resetModuleDiscoveryCache());

  // ---------------------------------------------------------------- POSITIVE CONTROL (sibling-green)
  // Run FIRST (N318). This proves the counter CAN observe a zero second poll, so the RED below is
  // about the default and not about a broken instrument. If this goes red, nothing under it means
  // anything.
  it("CONTROL: with an explicit cacheTtlMs, the second poll performs zero manifest reads", async () => {
    const counter = { manifestReads: 0 };
    const env = envWithModules(BOUND_MODULES, counter);

    const mods1 = await discoverModules(env, { cacheTtlMs: 60_000, nowMs: 1_000 });
    const firstPoll = counter.manifestReads;
    // DENOMINATOR: the fixture must produce a REAL, POPULATED registry. An empty registry
    // still counts fetches, so without this the suite could pass about a population that
    // production cannot produce (a manifest rejected by validateManifest is skipped).
    expect(mods1.length).toBe(BOUND_MODULES);
    // DENOMINATOR, asserted so a dead fixture is a harness failure and never a pass.
    expect(firstPoll).toBe(BOUND_MODULES);

    await discoverModules(env, { cacheTtlMs: 60_000, nowMs: 9_000 }); // 8s later: inside the TTL
    const secondPoll = counter.manifestReads - firstPoll;
    expect(secondPoll).toBe(0);
  });

  // ---------------------------------------------------------------- THE CLAIM (must be RED today)
  // This is the acceptance from the issue. The render path calls discoverModules with NO opts, so
  // this drives exactly the shape the render path uses.
  it("the second poll inside the TTL performs zero manifest reads (DEFAULT path)", async () => {
    const counter = { manifestReads: 0 };
    const env = envWithModules(BOUND_MODULES, counter);

    // Poll 1 -- the render path's bare call, exactly as film-orchestrator makes it.
    const mods1 = await discoverModules(env);
    const firstPoll = counter.manifestReads;
    expect(mods1.length).toBe(BOUND_MODULES);
    expect(firstPoll).toBe(BOUND_MODULES);

    // Poll 2 -- 8 seconds later, the panel's next render poll. Well inside any plausible TTL.
    await discoverModules(env);
    const secondPoll = counter.manifestReads - firstPoll;

    expect(secondPoll).toBe(0);
  });
});
