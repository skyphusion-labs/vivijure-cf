import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as viaShared from "../modules/_shared/runpod-route";
import * as viaCore from "@skyphusion-labs/vivijure-core/runpod-route";

// cp#321 step 2: modules/_shared/runpod-route.ts stopped being an implementation and became a
// POINTER at vivijure-core. These assertions exist because the two failure modes of that move are
// both silent.
//
// 1. THE RE-EXPORT STOPS COVERING WHAT MODULES IMPORT. 15 module workers import that path by name.
//    tsc catches a missing export at build time, but only for code that is compiled; this asserts
//    the surface at RUNTIME, through the same specifier the modules use.
// 2. A HAND COPY COMES BACK. Sync-checking the copy you KEPT protects only the copy you kept. When
//    the remedy is deleting a duplicate, the durable assertion is on the duplicate's ABSENCE, or
//    the deletion decays with nothing referencing it and nothing noticing.

const sharedPath = join(import.meta.dirname, "..", "modules", "_shared", "runpod-route.ts");

describe("modules/_shared/runpod-route re-exports core and adds nothing", () => {
  it("exposes the SAME export names as core, derived from both sides rather than listed here", () => {
    // Derived on both sides on purpose. A hardcoded list of 14 names would be a third copy of the
    // contract, in the test written to stop there being a second one.
    const shared = Object.keys(viaShared).sort();
    const core = Object.keys(viaCore).sort();
    expect(shared.length).toBeGreaterThan(0); // floor: two empty namespaces are trivially equal
    expect(shared).toEqual(core);
  });

  it("re-exports the SAME objects, not lookalikes", () => {
    // Identity, not shape. A local re-implementation with a matching surface would pass a
    // name-only comparison and would be exactly the duplicate this change removed.
    expect(viaShared.resolveRunpodRoute).toBe(viaCore.resolveRunpodRoute);
    expect(viaShared.PLANE_REFUSAL_HEADER).toBe(viaCore.PLANE_REFUSAL_HEADER);
    expect(viaShared.RUNPOD_DIRECT_BASE).toBe(viaCore.RUNPOD_DIRECT_BASE);
  });

  it("behaves through the shared path: bound base proxies, unbound falls back to the direct key", () => {
    // The integration the type system cannot assert: that the package subpath actually resolves at
    // runtime from a module's point of view, and that the rule arriving through it is the real one.
    const proxied = viaShared.resolveRunpodRoute("https://plane.example.test/api/runpod/v2", "tok", "key");
    expect(proxied.proxied).toBe(true);
    expect(proxied.credential).toBe("tok");
    const direct = viaShared.resolveRunpodRoute(undefined, "tok", "key");
    expect(direct.proxied).toBe(false);
    expect(direct.credential).toBe("key");
    expect(direct.base).toBe(viaCore.RUNPOD_DIRECT_BASE);
  });

  it("DECLARES NOTHING OF ITS OWN -- the guard on the deletion, not on the survivor", () => {
    const src = readFileSync(sharedPath, "utf8");
    // Comments are stripped FIRST. Without that, the file's own prose ("If you are about to add a
    // `const`, a `function`...") trips every matcher below, and a guard that its own documentation
    // fails is a guard someone deletes.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // Positive control on the stripper: the real declaration keyword must be findable in a string
    // KNOWN to contain one, or "no declarations" is a claim about a matcher that matches nothing.
    expect(/\bexport\s+const\b/.test("export const X = 1;")).toBe(true);
    expect(code).not.toMatch(/\bexport\s+(const|function|class|interface|type|enum)\b/);
    expect(code).not.toMatch(/\b(const|function|class|interface|enum)\s+[A-Za-z_]/);
    // And it must still be a re-export of core, so "declares nothing" cannot be satisfied by an
    // empty file that silently breaks all 15 modules.
    expect(code).toMatch(/export\s+\*\s+from\s+["']@skyphusion-labs\/vivijure-core\/runpod-route["']/);
  });
});
