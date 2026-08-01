// THE DENOMINATOR IS THE FINDING (cf#295).
//
// cf#295 measured 6 of 26 modules implementing /ready and named the danger: a sweep that cannot
// tell "not ready" from "no endpoint exists" answers with the reassuring one. That is FIXED --
// all 26 implement it now, and tests/module-ready-coverage-291.test.ts holds that invariant.
//
// THE GAP MOVED RATHER THAN CLOSING, and this file is about where it moved to. `module-readiness`
// on the control plane iterates TENANT_MODULE_CATALOG, which is SIX entries. Every one of them now
// answers 200, so the route looks complete while speaking for six of twenty-six. Before, an
// unimplemented sweep 404'd and the hole was visible in the result; now it is invisible unless
// somebody publishes the denominator. docs/module-readiness-coverage.md publishes it, and this file
// stops that page drifting away from the modules it describes -- a stale coverage table is the same
// defect the page exists to warn about.
//
// SCOPE, stated plainly. Three of the four populations are derived from THIS repo and are therefore
// really checked. The fourth (what the control plane provisions) lives in another repo and is
// DECLARED here, not verified -- see CATALOG below. Saying which columns are measured and which are
// asserted-from-elsewhere is the same honesty the page demands of its readers.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MODULES_DIR = join(ROOT, "modules");
const DOC = join(ROOT, "docs", "module-readiness-coverage.md");

function moduleSources(): { name: string; source: string }[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .map((e) => ({ name: e.name, path: join(MODULES_DIR, e.name, "src", "index.ts") }))
    .filter((m) => {
      try { readFileSync(m.path); return true; } catch { return false; }
    })
    .map((m) => ({ name: m.name, source: readFileSync(m.path, "utf8") }));
}

const ENTRIES = moduleSources();

// ANCHORED, not a substring. A module that only MENTIONS /ready in a comment must not count as
// implementing it; cf#295's own remediation added exactly such comments across the tree.
const READY = ENTRIES.filter((m) => m.source.includes('url.pathname === "/ready"')).map((m) => m.name);
const REPORTS_JOB_LOG = ENTRIES.filter((m) => m.source.includes("telemetry: { job_log")).map((m) => m.name);
const WRITES_JOB_LOG = ENTRIES.filter((m) => m.source.includes("recordRunpodJob")).map((m) => m.name);

/** Population 3: what a studio release publishes as tenant module bundles. Parsed from the workflow
 *  that resolves it, which the workflow itself calls the single source for three consumers. */
function publishedToTenants(): string[] {
  const wf = readFileSync(join(ROOT, ".github", "workflows", "studio-release.yml"), "utf8");
  const line = wf.split("\n").find((l) => l.includes("TENANT_MODULES=keyframe"));
  if (!line) throw new Error("could not find the TENANT_MODULES resolution line in studio-release.yml");
  const named = (line.match(/TENANT_MODULES=([a-z- ]+)/)?.[1] ?? "").trim().split(/\s+/);
  const satellites = readFileSync(join(ROOT, "scripts", "finish-satellite-modules.txt"), "utf8")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  return [...named, ...satellites].sort();
}

/**
 * Population 4: DECLARED, NOT MEASURED.
 *
 * TENANT_MODULE_CATALOG lives in vivijure-control-plane/src/tenant-modules.ts and this repo cannot
 * read it. So this constant is a claim about another repo, and a change there will NOT fail this
 * test. It is pinned here so the published table has one place to be corrected, and so the gap is
 * named rather than papered over. If you are chasing a mismatch, read the control plane first.
 */
const CATALOG = ["keyframe", "own-gpu", "finish-upscale", "finish-lipsync", "speech-upscale", "plan-enhance"].sort();

describe("the readiness denominator is published and does not drift (cf#295)", () => {
  it("the scan read the tree (positive control)", () => {
    // Every assertion below is shaped so that a scan reading NOTHING would produce empty sets and
    // pass. Pin real data with named members so a path or parse regression is loud.
    expect(ENTRIES.length).toBeGreaterThan(20);
    expect(READY).toContain("keyframe");
    expect(WRITES_JOB_LOG).toContain("finish-rife");
    expect(REPORTS_JOB_LOG).toContain("speech-upscale");
    expect(publishedToTenants()).toContain("plan-enhance");
  });

  it("the anchored /ready matcher DISCRIMINATES a handler from a mere mention", () => {
    // The control that matters for this file's headline number, since every other assertion here
    // rests on READY being right.
    //
    // The realistic false positive is a module that CALLS a /ready rather than serving one -- which
    // is exactly what the control plane's probe does. A substring matcher counts that as an
    // implementation; the anchored one does not.
    //
    // MEASURED, not assumed: today no module contains a quoted "/ready" outside its handler line, so
    // the anchored and substring matchers currently agree, and tests/module-ready-coverage-291.test.ts
    // is not reporting a wrong number. Anchoring is strictly stronger for the day one of them stops
    // agreeing, which is the only day it would matter and the day nobody would be looking.
    const caller = 'const res = await fetch(base + "/ready");\n';
    expect(caller.includes('"/ready"')).toBe(true);
    expect(caller.includes('url.pathname === "/ready"')).toBe(false);

    const handler = 'if (request.method === "GET" && url.pathname === "/ready") {\n';
    expect(handler.includes('url.pathname === "/ready"')).toBe(true);
  });

  it("all 26 modules implement an anchored /ready (cf#295's original defect, now fixed)", () => {
    expect(READY.length).toBe(ENTRIES.length);
  });

  it("reporting telemetry.job_log and writing job-log rows are the SAME six modules", () => {
    // If these ever diverge, one of two real bugs exists: a module that records but cannot say so
    // (invisible failures), or one that claims a job log it never writes (a false green).
    expect([...REPORTS_JOB_LOG].sort()).toEqual([...WRITES_JOB_LOG].sort());
    expect(WRITES_JOB_LOG.length).toBe(6);
  });

  it("the four populations are the sizes the published table claims", () => {
    expect(ENTRIES.length).toBe(26);
    expect(WRITES_JOB_LOG.length).toBe(6);
    expect(publishedToTenants().length).toBe(7);
    expect(CATALOG.length).toBe(6);
  });

  it("the two asymmetries hold: finish-rife published-not-provisioned, plan-enhance provisioned-not-recording", () => {
    // These are the two cases that get misread, so they are asserted by name rather than by count.
    expect(publishedToTenants()).toContain("finish-rife");
    expect(CATALOG).not.toContain("finish-rife");
    expect(WRITES_JOB_LOG).toContain("finish-rife");

    expect(CATALOG).toContain("plan-enhance");
    expect(WRITES_JOB_LOG).not.toContain("plan-enhance");
  });

  it("what module-readiness covers is a STRICT subset of the repo, and the page says so", () => {
    expect(CATALOG.length).toBeLessThan(ENTRIES.length);
    const doc = readFileSync(DOC, "utf8");
    // The denominator has to appear in the prose, not only in a table cell a reader can skim past.
    expect(doc).toContain("6 of 26");
  });

  it("the published table matches the modules, row for row", () => {
    const doc = readFileSync(DOC, "utf8");
    const rows = new Map<string, string[]>();
    for (const line of doc.split("\n")) {
      const m = /^\| ([a-z0-9-]+) \| (.+) \|$/.exec(line.trim());
      if (m && ENTRIES.some((e) => e.name === m[1])) {
        rows.set(m[1], m[2].split("|").map((c) => c.replace(/\*/g, "").trim().toLowerCase()));
      }
    }
    expect(rows.size, "table rows found in the doc").toBe(ENTRIES.length);

    for (const { name } of ENTRIES) {
      const cells = rows.get(name);
      expect(cells, `no table row for module ${name}`).toBeDefined();
      const [ready, reports, writes, published, provisioned] = cells!;
      expect(ready, `${name}: /ready column`).toBe(READY.includes(name) ? "yes" : "no");
      expect(reports, `${name}: telemetry column`).toBe(REPORTS_JOB_LOG.includes(name) ? "yes" : "no");
      expect(writes, `${name}: job-log column`).toBe(WRITES_JOB_LOG.includes(name) ? "yes" : "no");
      expect(published, `${name}: published column`).toBe(publishedToTenants().includes(name) ? "yes" : "no");
      expect(provisioned, `${name}: provisioned column`).toBe(CATALOG.includes(name) ? "yes" : "no");
    }
  });
});
