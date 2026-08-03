// cf#394: the canonical list of modules a studio release publishes as TENANT bundles.
//
// WHY THIS FILE EXISTS. Until cf#394 the publish set lived in two places -- three names inline in
// studio-release.yml plus scripts/finish-satellite-modules.txt, a file named for a DIFFERENT class
// with four other consumers. Nobody could answer "what publishes as a tenant bundle" in one read,
// and on 2026-08-03 that cost a lane its direction: the control plane's TENANT_MODULE_CATALOG had
// grown to exactly equal the publish set, leaving zero headroom, and no artifact anywhere said so.
//
// Consolidating into one file creates ONE new hazard, and this suite exists to hold it: the four
// finish satellites are now named in two files. That duplication is checked here rather than left
// to drift, which is the whole difference between a fork and an invariant.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const LIST = join(ROOT, "scripts", "tenant-release-modules.txt");
const SATELLITES = join(ROOT, "scripts", "finish-satellite-modules.txt");
const WORKFLOW = join(ROOT, ".github", "workflows", "studio-release.yml");

/** The parse rule, stated once and identical to the shell's (`grep -vE "^[[:space:]]*$"`): bare
 *  names, one per line, blank lines skipped. Deliberately NOT extended with a comment syntax --
 *  two parsers with two rules for one file is the drift this suite exists to prevent. */
const parse = (path: string): string[] =>
  readFileSync(path, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);

const TENANT_MODULES = parse(LIST);
const FINISH_SATELLITES = parse(SATELLITES);

describe("the tenant release module list is well-formed", () => {
  it("CONTROL: the file parses to real content, so every assertion below can fail", () => {
    // Without this, a file that vanished or parsed to [] would satisfy the subset and duplicate
    // checks vacuously and report a clean suite.
    expect(TENANT_MODULES.length).toBeGreaterThan(10);
    expect(TENANT_MODULES).toContain("keyframe");
    expect(TENANT_MODULES).not.toContain("no-such-module-cf394");
  });

  it("names no module twice", () => {
    // A duplicate would bundle the same module twice in a release and is invisible by eye at 16.
    expect([...new Set(TENANT_MODULES)].sort()).toEqual([...TENANT_MODULES].sort());
  });

  it("every named module EXISTS, so a typo cannot silently drop a bundle", () => {
    // The release loop runs `cd modules/$m`. A misspelled name fails the release at bundle time,
    // which is loud but late; this is the same fact, cheap, at PR time.
    for (const m of TENANT_MODULES) {
      expect(existsSync(join(ROOT, "modules", m, "wrangler.toml")), `modules/${m}/wrangler.toml`).toBe(true);
    }
    // Control: the check can return false.
    expect(existsSync(join(ROOT, "modules", "no-such-module-cf394", "wrangler.toml"))).toBe(false);
  });
});

describe("the two list files cannot drift apart", () => {
  it("every finish satellite is also a published tenant module", () => {
    // The duplication cf#394 introduced, converted into an invariant. A satellite dropped from the
    // tenant list would stop shipping to tenants while still deploying for the operator -- two
    // states that look identical from either file alone.
    for (const m of FINISH_SATELLITES) {
      expect(TENANT_MODULES, `finish satellite ${m} must also be published to tenants`).toContain(m);
    }
    expect(FINISH_SATELLITES.length).toBeGreaterThan(0); // denominator: an empty file proves nothing
  });

  it("the two files are NOT the same list, so neither can be collapsed into the other by accident", () => {
    // finish-satellite-modules.txt narrows an OPERATOR deploy (FINISH_SATELLITES_ONLY) and feeds two
    // test denominators. It is a strict subset on purpose. If these ever became equal, someone has
    // conflated a deploy-narrowing list with a publish list and the next reader will too.
    expect(TENANT_MODULES.length).toBeGreaterThan(FINISH_SATELLITES.length);
  });
});

describe("the list is actually consumed", () => {
  it("studio-release.yml resolves TENANT_MODULES from this file", () => {
    // A canonical list nothing reads is worse than the composition it replaced: it looks
    // authoritative and governs nothing. Asserted against the workflow text, with a control.
    const wf = readFileSync(WORKFLOW, "utf8");
    expect(wf).toContain("scripts/tenant-release-modules.txt");
    expect(wf).toContain('TENANT_MODULES="$(grep');
    // CONTROL: the old inline composition must be GONE, or both could be live and disagree.
    expect(wf).not.toContain("TENANT_MODULES=keyframe own-gpu plan-enhance");
  });

  it("the workflow refuses an empty list rather than publishing a release with no tenant modules", () => {
    // The failure this guards is silent by construction: an empty resolution publishes a release
    // whose modules/ tree is empty, and every downstream check that reads a MODULE would pass by
    // finding nothing to object to.
    const wf = readFileSync(WORKFLOW, "utf8");
    expect(wf).toContain("resolved to NOTHING");
  });
});
