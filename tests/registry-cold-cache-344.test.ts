/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// cf#344 cold-cache requirement, per the ruling on the issue: the panel AWAITS the registry, and a
// registry that FAILS produces a clear pre-submit refusal rather than an indefinite wait or a silent
// omission. The property that has to survive is that the guard can always fail and nothing is
// silently substituted.
//
// The defect lived in the INTERVAL between two individually-correct changes: cf#345 omitted
// motion_backend on a cold cache (correct while the server defaults), and the strict #500 guard is
// correct given a panel that always names one. Neither lane could see it alone.

function registry(fetchImpl: () => Promise<unknown>) {
  const src = readFileSync(`${process.cwd()}/public/planner-registry.js`, "utf8");
  const scope: { plannerRegistry?: Record<string, (...a: unknown[]) => unknown> } = {};
  new Function("window", "fetch", src)(scope, fetchImpl);
  return scope.plannerRegistry!;
}

const MODULES = {
  modules: [{ name: "own-gpu", hooks: ["motion.backend"], ui: { locality: "byo", order: 5 } }],
  hooks: { "motion.backend": ["own-gpu"] },
  catalog: [],
};

const ok = () => Promise.resolve({ ok: true, json: () => Promise.resolve(MODULES) });
const empty = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ modules: [], hooks: {}, catalog: [] }) });
const notOk = () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
const boom = () => Promise.reject(new Error("network down"));

describe("cf#344 an unreachable registry is distinguishable from an empty one", () => {
  // This is the whole reason a flag was added. Before it, both states resolved to a byte-identical
  // empty cache, so a caller that must NAME a module could not tell "this studio has no GPU door"
  // from "I could not ask" -- and those refusals name different parties.
  it.each([
    ["a non-ok response", notOk, true],
    ["a transport failure", boom, true],
    ["an EMPTY but successful projection", empty, false],
    ["a populated projection", ok, false],
  ])("%s -> registryUnavailable() === %s", async (_label, impl, expected) => {
    const reg = registry(impl as () => Promise<unknown>);
    await reg.load();
    expect(reg.registryUnavailable()).toBe(expected);
  });

  it("an empty projection and a failed one still yield the SAME door result", async () => {
    // Proving the flag is load-bearing: without it these two are indistinguishable at the point of
    // decision, which is exactly the state the ruling refuses.
    const failed = registry(notOk);
    await failed.load();
    const emptied = registry(empty);
    await emptied.load();
    expect(failed.defaultGpuDoorModule()).toBeNull();
    expect(emptied.defaultGpuDoorModule()).toBeNull();
  });

  it("registryUnavailable() is false BEFORE any load, so it cannot be read early by accident", async () => {
    const reg = registry(notOk);
    expect(reg.registryUnavailable()).toBe(false);
    await reg.load();
    expect(reg.registryUnavailable()).toBe(true);
  });

  it("NEGATIVE CONTROL: existing readers still degrade quietly on a failed load", async () => {
    // The flag is additive. If adding it had changed load()'s resolve-never-reject contract, every
    // read-only control in the panel would start throwing on a cold studio.
    const reg = registry(boom);
    await expect(reg.load()).resolves.toBeTruthy();
    expect(reg.motionBackendModules()).toEqual([]);
    expect(reg.gpuMotionLabel()).toBe("GPU i2v");
  });
});

describe("cf#344 the submit path awaits and refuses before spend", () => {
  const BUNDLE = readFileSync(`${process.cwd()}/public/planner-bundle.js`, "utf8");
  const fn = BUNDLE.slice(
    BUNDLE.indexOf("async function renderFromKeyframes"),
    BUNDLE.indexOf("function promptCustomBundle"),
  );

  it("it awaits the registry before deciding anything", () => {
    expect(fn).toContain("await registry.load();");
  });

  it("both refusals exist and are DIFFERENT, because they name different parties", () => {
    expect(fn).toContain("cannot reach the studio module registry");
    expect(fn).toContain("no GPU door is installed on this studio");
  });

  it("both refusals come BEFORE the confirm and before any fetch", () => {
    // A refusal after the confirm asks the user to approve a render that will not be submitted; a
    // refusal after the fetch is not a pre-spend refusal at all.
    const confirmAt = fn.indexOf("window.confirm(");
    const submitAt = fn.indexOf('fetch("/api/storyboard/render-from-keyframes"');
    expect(confirmAt, "the confirm is gone; re-anchor this test").toBeGreaterThan(-1);
    expect(submitAt, "the submit is gone; re-anchor this test").toBeGreaterThan(-1);
    for (const refusal of ["cannot reach the studio module registry", "no GPU door is installed"]) {
      expect(fn.indexOf(refusal), `${refusal} moved after the confirm`).toBeLessThan(confirmAt);
      expect(fn.indexOf(refusal), `${refusal} moved after the submit`).toBeLessThan(submitAt);
    }
  });

  it("the field is now UNCONDITIONAL: there is no path that submits without naming a door", () => {
    // The silent-omission branch is what the ruling forbids. Its absence is the assertion.
    expect(fn).toContain("body.motion_backend = gpuDoor.name;");
    expect(fn).not.toContain("if (gpuDoor && gpuDoor.name) body.motion_backend");
  });

  it("POSITIVE CONTROL: the slice really is the submit function", () => {
    // Every assertion above passes against an empty string.
    expect(fn.length).toBeGreaterThan(500);
    expect(fn).toContain("render-from-keyframes");
  });
});
