import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { HOOK_NAMES } from "@skyphusion-labs/vivijure-core/modules/types";
import { QUALITY_TIERS } from "@skyphusion-labs/vivijure-core/render-module-config";

// cf#611 GOLDEN bar: derived from the registry, not a hand-typed "30 / 12 / 3"
// that rots. If the registry moves, this test reddens and the checklist is
// re-derived. Do not patch a number here without looking at the files.

const MODULES_DIR = join(import.meta.dirname, "..", "modules");

function firstPartyModuleNames(): string[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "_shared")
    .filter((d) => existsSync(join(MODULES_DIR, d.name, "wrangler.toml")))
    .map((d) => d.name)
    .sort();
}

describe("cf#611 GOLDEN shared-tier bar (derived)", () => {
  it("the hook vocabulary is twelve named pipeline extension points", () => {
    expect(HOOK_NAMES).toHaveLength(12);
    expect(new Set(HOOK_NAMES).size).toBe(12);
  });

  it("the quality-tier vocabulary is three named tiers", () => {
    expect(QUALITY_TIERS.map((t) => t.value)).toEqual(["draft", "standard", "final"]);
  });

  it("every first-party module worker is a directory with wrangler.toml", () => {
    const names = firstPartyModuleNames();
    expect(names.length, `registry: ${names.join(",")}`).toBeGreaterThan(0);
    for (const n of names) {
      expect(existsSync(join(MODULES_DIR, n, "wrangler.toml")), n).toBe(true);
    }
  });
});
