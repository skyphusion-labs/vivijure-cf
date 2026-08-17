/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// cf#534: docs/SECURITY.md used to type a captured-manifest count by hand. That digit
// went stale the moment the demo seed changed, and nothing could notice. The doc now
// points at GET /api/modules; this file is the gate that can go red.
//
// Two relations, neither of them a typed integer next to a copy of itself:
//   1. SECURITY.md (and the seed header) must not claim a digit-bearing captured-manifest count.
//   2. Every name the demo seed installs must exist as a live first-party module in modules/.

const ROOT = join(import.meta.dirname, "..");
const SECURITY = join(ROOT, "docs", "SECURITY.md");
const SEED = join(ROOT, "migrations", "demo", "0001_demo_seed.sql");
const MODULES_DIR = join(ROOT, "modules");

const HAND_TYPED_COUNT = /\d+\s+(captured module manifests|in-repo module manifests)/;

function liveModuleNames(): string[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .map((e) => e.name)
    .sort();
}

function seedModuleNames(): string[] {
  const sql = readFileSync(SEED, "utf8");
  const names = [...sql.matchAll(/INSERT OR IGNORE INTO installed_modules[\s\S]*?\(\s*'([^']+)'/g)]
    .map((m) => m[1]);
  return names.sort();
}

describe("cf#534 demo seed manifest count is derived, not typed", () => {
  it("SECURITY.md does not carry a hand-typed captured-manifest count", () => {
    const doc = readFileSync(SECURITY, "utf8");
    expect(doc, "re-typed a stale integer; point at GET /api/modules").not.toMatch(HAND_TYPED_COUNT);
    expect(doc, "the pointer itself is gone").toMatch(/see GET \/api\/modules/);
  });

  it("the seed header does not carry a hand-typed count either", () => {
    const header = readFileSync(SEED, "utf8").split("\n").filter((l) => l.startsWith("--")).join("\n");
    expect(header).not.toMatch(HAND_TYPED_COUNT);
  });

  it("every seeded installed_modules name is a live first-party module", () => {
    const live = liveModuleNames();
    const seeded = seedModuleNames();
    expect(seeded.length, "seed installed no modules; matcher is broken").toBeGreaterThan(0);
    expect(live.length, "modules/ tree is empty; matcher is broken").toBeGreaterThan(seeded.length);
    const missing = seeded.filter((n) => !live.includes(n));
    expect(missing, "seed names that are not in modules/").toEqual([]);
  });

  it("POSITIVE CONTROL: the matcher can see a hand-typed count", () => {
    expect(HAND_TYPED_COUNT.test("the 26 captured module manifests + fictional")).toBe(true);
    expect(HAND_TYPED_COUNT.test("the 26 in-repo module manifests, captured")).toBe(true);
    expect(HAND_TYPED_COUNT.test("captured module manifests -- see GET /api/modules")).toBe(false);
  });
});
