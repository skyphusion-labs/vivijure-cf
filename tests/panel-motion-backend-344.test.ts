/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { defaultGpuDoorModule as coreDefaultGpuDoor } from "@skyphusion-labs/vivijure-core/modules/registry";

// cf#344: the panel sent NO motion_backend on render-from-keyframes, so the door defaulted one and
// the #500/#504 motion-backend preflight could not be adopted there -- the guard refuses exactly the
// request the button sends.
//
// Two things have to hold and they fail in opposite ways:
//   1. The panel names a door. If it does not, the strict guard 400s the button.
//   2. It names the SAME door the core would have defaulted to. If not, "make it explicit" quietly
//      REROUTES renders instead of just declaring where they already went.
//
// The shipped planner-registry.js is evaluated against a stub scope so the real helper is asserted.

/** A motion.backend module fixture in the shape BOTH sides actually consume: the core reads
 *  `hooks`, the panel reads the `hooks` map on the payload. A fixture missing `hooks` is not a
 *  module, and the first draft of this file proved it by throwing inside the core. */
function motionModule(name: string, locality: string, order: number) {
  return { name, hooks: ["motion.backend"], ui: { locality, order } };
}

// cf#580: the memo moved to public/module-registry.js, so this harness mirrors what the PAGE does:
// construct the shared registry with the transport, then eval planner-registry.js against a scope
// that carries it. planner-registry.js deliberately THROWS when the shared file is absent rather
// than falling back to its own fetch, so a harness that skipped this step fails loudly instead of
// quietly re-testing a second memo that no longer ships.
function sharedRegistry(fetchImpl: () => Promise<unknown>) {
  const src = readFileSync(process.cwd() + "/public/module-registry.js", "utf8");
  const scope: { moduleRegistry?: Record<string, (...a: unknown[]) => unknown> } = {};
  new Function("window", src)(scope);
  (scope.moduleRegistry!.setTransport as (f: unknown) => void)(fetchImpl);
  return scope.moduleRegistry!;
}

function registryWith(modules: {
  name: string;
  hooks?: string[];
  ui?: { locality?: string; order?: number };
  config_schema?: Record<string, unknown>;
}[]) {
  const src = readFileSync(`${process.cwd()}/public/planner-registry.js`, "utf8");
  const payload = {
    modules,
    hooks: { "motion.backend": modules.map((m) => m.name) },
    catalog: [],
  };
  const scope: {
    plannerRegistry?: Record<string, (...a: unknown[]) => unknown>;
    moduleRegistry?: unknown;
  } = {};
  scope.moduleRegistry = sharedRegistry(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }),
  );
  new Function("window", src)(scope);
  const reg = scope.plannerRegistry!;
  // load() is typed unknown through the Function() boundary; narrow it explicitly rather than
  // casting the whole chain, so a load() that stops returning a thenable fails here.
  const loaded = reg.load() as Promise<unknown>;
  return loaded.then(() => reg);
}

const BYO = motionModule("own-gpu", "byo", 5);
const LOCAL = motionModule("local-gpu", "local", 4);
const CLOUD = motionModule("seedance", "cloud", 10);

describe("cf#344 the panel resolves the SAME gpu door the core would default to", () => {
  // The live studio's own shape: a local door ordered BEFORE the byo door. Both must still pick
  // byo, which is the case a naive "first gpu door" rule would get wrong.
  it.each([
    ["live shape: local ordered before byo", [LOCAL, BYO, CLOUD], "own-gpu"],
    ["byo only", [BYO, CLOUD], "own-gpu"],
    ["local only, no byo", [LOCAL, CLOUD], "local-gpu"],
    ["byo listed after clouds", [CLOUD, BYO], "own-gpu"],
  ])("%s", async (_label, modules, expected) => {
    const reg = await registryWith(modules);
    const panel = reg.defaultGpuDoorModule() as { name: string } | null;
    expect(panel?.name, "panel picked a different door").toBe(expected);
    // The core, driven with the same module set, must agree. This is the assertion that makes the
    // change a DECLARATION rather than a reroute.
    const core = coreDefaultGpuDoor(modules as never);
    expect(core?.name, "panel and core disagree about the default door").toBe(panel?.name);
  });

  it("no gpu door installed: the panel names NOTHING rather than inventing one", async () => {
    const reg = await registryWith([CLOUD]);
    expect(reg.defaultGpuDoorModule()).toBeNull();
    expect(coreDefaultGpuDoor([CLOUD] as never)).toBeUndefined();
  });

  it("NEGATIVE CONTROL: a cloud door is never offered as the gpu default", async () => {
    // Without this, a helper that returned the first motion backend of any kind would satisfy the
    // rows above whenever a gpu door happened to sort first.
    const reg = await registryWith([CLOUD, LOCAL]);
    expect((reg.defaultGpuDoorModule() as { name: string }).name).toBe("local-gpu");
    expect((reg.gpuDoorMotionModules() as { name: string }[]).map((m) => m.name)).toEqual(["local-gpu"]);
  });
});

describe("cf#344 the wire field name", () => {
  const BUNDLE = readFileSync(`${process.cwd()}/public/planner-bundle.js`, "utf8");
  const INDEX = readFileSync(`${process.cwd()}/src/index.ts`, "utf8");

  it("the panel sets snake_case motion_backend, which is what the route reads", () => {
    // This line's failure mode is SILENCE: a camelCase guess is ignored and the render still
    // succeeds on the door's own default, so nothing surfaces it. Both halves are asserted
    // against the shipped files rather than remembered, because they are spelled differently
    // from every camelCase sibling in the same request body.
    expect(BUNDLE, "the panel no longer sets motion_backend").toContain("body.motion_backend = gpuDoor.name");
    expect(INDEX, "the route no longer reads b.motion_backend").toContain("b.motion_backend ??");
  });

  it("NEGATIVE CONTROL: the panel does NOT send a camelCase motionBackend on this body", () => {
    expect(BUNDLE).not.toContain("body.motionBackend");
  });

  it("the field is UNCONDITIONAL: the omission branch is deliberately gone", () => {
    // This assertion used to require the OPPOSITE, and it was right at the time: cf#345 omitted the
    // field on a cold registry cache to preserve pre-cf#344 behaviour, which holds only while the
    // server still defaults a backend. The cf#344 cold-cache ruling removed that branch, because
    // once #500/#504 is enforced the omission stops degrading and starts returning "choose a motion
    // backend" -- a refusal naming the USER on a button whose job is choosing for them.
    //
    // Updated rather than deleted. A guard that fails on a deliberate change has done its job, and
    // the fix is to state the new contract where the old one was, not to remove the question.
    // The refusals that replaced the branch are asserted in tests/registry-cold-cache-344.test.ts.
    expect(BUNDLE).toContain("body.motion_backend = gpuDoor.name;");
    expect(BUNDLE, "the silent-omission branch is back; cf#344's ruling forbids it")
      .not.toContain("if (gpuDoor && gpuDoor.name) body.motion_backend");
  });
});

describe("cf#474 Wan LoRA motion is a registry capability, not a compiled name", () => {
  it("isWanLoraMotion keys on dual expert LoRA schema fields", async () => {
    const wan = {
      name: "cloud-lora-door",
      hooks: ["motion.backend"],
      ui: { locality: "cloud", order: 75 },
      config_schema: { high_noise_loras: { type: "string" }, low_noise_loras: { type: "string" } },
    };
    const plain = {
      name: "cloud-plain-door",
      hooks: ["motion.backend"],
      ui: { locality: "cloud", order: 70 },
      config_schema: { enable_prompt_expansion: { type: "bool" } },
    };
    const reg = await registryWith([wan, plain]);
    expect(reg.isWanLoraMotion(wan)).toBe(true);
    expect(reg.isWanLoraMotion(plain)).toBe(false);
    expect(reg.isWanLoraMotion(null)).toBe(false);
    const mods = reg.motionBackendModules() as { name: string }[];
    expect(mods.map((m) => m.name)).toEqual(["cloud-lora-door", "cloud-plain-door"]);
  });
});
