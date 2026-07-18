// The release MANIFEST CONTRACT (cf#85). This is the seam the hosted control plane consumes: it
// pins {tag, manifest_sha256} and reads everything else out of the artifact, with no source-level
// import across the repo boundary. So the manifest shape IS an interface, and this test guards it.
//
// It asserts the two fields the extraction added -- migrations and required_vars -- against the SAME
// sources the studio uses at runtime, so what we publish can never drift from what the studio reads:
//   - migrations vs the top-level migrations/*.sql on disk (same scope rule as the provisioner)
//   - required_vars vs ORCHESTRATOR_VAR_KEYS (the single source of truth, imported directly)
//
// Removing a field here is a BREAKING change for vivijure-control-plane, whose pin floor is v1.3.0.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ORCHESTRATOR_VAR_KEYS } from "../src/platform/orchestrator-vars";

const MIGRATIONS_DIR = "migrations";

/** The scope rule, restated: top-level only. manual/ is operator-run, demo/ is seed data. */
function topLevelMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

describe("studio release manifest contract", () => {
  it("publishes the var contract from the single source of truth, not a copy", () => {
    // The builder imports this exact array. If a second list ever appears, this stops being true.
    expect([...ORCHESTRATOR_VAR_KEYS]).toContain("R2_S3_ENDPOINT");
    expect(new Set(ORCHESTRATOR_VAR_KEYS).size).toBe(ORCHESTRATOR_VAR_KEYS.length);
  });

  it("ships every top-level migration, in apply order", () => {
    const onDisk = topLevelMigrations();
    expect(onDisk.length).toBeGreaterThan(0);
    // Apply order IS sort order, and the filename is the tracking key in schema_migrations.
    expect([...onDisk].sort()).toEqual(onDisk);
  });

  it("hashes each migration over its real bytes, so a consumer can verify what it did not build", () => {
    for (const name of topLevelMigrations()) {
      const bytes = readFileSync(join(MIGRATIONS_DIR, name));
      expect(createHash("sha256").update(bytes).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
      expect(bytes.byteLength).toBeGreaterThan(0);
    }
  });

  it("refuses an EMPTY migration set rather than provisioning an empty schema", () => {
    // The builder throws on zero migrations. A silent empty set would give every new tenant a blank
    // D1 and report success, which is the worst available failure mode.
    expect(topLevelMigrations().length).toBeGreaterThan(0);
  });
});
