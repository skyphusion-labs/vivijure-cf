// THE DENOMINATOR IS THE FINDING (cf#295).
//
// cf#295 measured 6 of N modules implementing /ready and named the danger: a sweep that cannot
// tell "not ready" from "no endpoint exists" answers with the reassuring one. That is FIXED --
// every module implements it now, and tests/module-ready-coverage-291.test.ts holds that invariant.
// N is the modules/ tree size (see ENTRIES); it grows when new modules land.
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
  // cf#394: read the canonical list rather than regex-parsing a shell line out of the workflow.
  // The old form matched `TENANT_MODULES=([a-z- ]+)` against a composed command, so it could only
  // ever see the INLINE half of the set and silently depended on the literal `=keyframe` prefix --
  // a matcher over shell text, which is the shape that keeps producing plausible wrong values here.
  const list = readFileSync(join(ROOT, "scripts", "tenant-release-modules.txt"), "utf8")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new Error("tenant-release-modules.txt parsed to nothing");
  return [...list].sort();
}

/**
 * Population 4: DECLARED, NOT MEASURED.
 *
 * TENANT_MODULE_CATALOG lives in vivijure-control-plane/src/tenant-modules.ts and this repo cannot
 * read it. So this constant is a claim about another repo, and a change there will NOT fail this
 * test. It is pinned here so the published table has one place to be corrected, and so the gap is
 * named rather than papered over. If you are chasing a mismatch, read the control plane first.
 *
 * THE GAP THIS FILE NAMED HAS NOW BEEN HIT, WHICH IS WORTH RECORDING RATHER THAN QUIETLY FIXING.
 * vivijure-control-plane#313 added `finish-rife` to that catalog on 2026-08-03, making this
 * constant false for roughly three hours. Nothing failed, because the assertions below compare this
 * constant against itself -- exactly what the paragraph above predicts. Corrected here by hand,
 * which is the only mechanism available to a repo that cannot read the other one.
 */
const CATALOG = ["keyframe", "own-gpu", "finish-upscale", "finish-lipsync", "speech-upscale",
                 "finish-rife", "plan-enhance"].sort();

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

  it("every module implements an anchored /ready (cf#295's original defect, now fixed)", () => {
    expect(READY.length).toBe(ENTRIES.length);
  });

  it("reporting telemetry.job_log and writing job-log rows are the SAME fourteen modules", () => {
    // If these ever diverge, one of two real bugs exists: a module that records but cannot say so
    // (invisible failures), or one that claims a job log it never writes (a false green).
    expect([...REPORTS_JOB_LOG].sort()).toEqual([...WRITES_JOB_LOG].sort());
    // cf#305: was 6. The eight cost-door submitters (seedance, kling, vidu-q3, google-veo,
    // minimax-hailuo, alibaba-wan, alibaba-wan-lora, narration-gen) wrote NO row at all, so a
    // census of the table showed six healthy lanes and could not mention the other eight.
    expect(WRITES_JOB_LOG.length).toBe(14);
    for (const m of ["seedance", "kling", "vidu-q3", "google-veo", "minimax-hailuo", "alibaba-wan", "alibaba-wan-lora", "narration-gen"]) {
      expect(WRITES_JOB_LOG, "cost-door module not recording: " + m).toContain(m);
    }
  });

  it("the four populations are the sizes the published table claims", () => {
    // 30 as of four CF AI i2v modules (cf-hh1-r2v, cf-seedance, cf-grok-video, cf-flux-3-video).
    expect(ENTRIES.length).toBe(30);
    expect(WRITES_JOB_LOG.length).toBe(14);
    // cf#394 moved this from 7 to 16: the 8 cost-door modules and image-generate now publish a
    // tenant bundle. A bundle with no catalog row uploads nothing, so publishing is inert until the
    // plane adds rows; it exists to remove the cross-repo serialisation, not to change behaviour.
    expect(publishedToTenants().length).toBe(16);
    // cp#284 moved this from 6 to 7 (finish-rife). DECLARED, not measured -- see the note above.
    expect(CATALOG.length).toBe(7);
  });

  it("the asymmetries that remain, by name rather than by count", () => {
    // finish-rife's published-not-provisioned asymmetry is GONE: cp#284 catalogued it, so it is now
    // published AND provisioned AND recording. Asserted in its new shape rather than deleted,
    // because the old assertion is the record of a real state that lasted from cf#295 to cp#284.
    expect(publishedToTenants()).toContain("finish-rife");
    expect(CATALOG).toContain("finish-rife");
    expect(WRITES_JOB_LOG).toContain("finish-rife");

    // plan-enhance keeps its own asymmetry: provisioned, and records nothing because it submits no
    // RunPod job at all.
    expect(CATALOG).toContain("plan-enhance");
    expect(WRITES_JOB_LOG).not.toContain("plan-enhance");

    // cf#394's asymmetry, and the one that matters now: the nine new modules PUBLISH a bundle and
    // are NOT in the catalog. That is the deliberate intermediate state -- a bundle with no row
    // uploads nothing -- and it is what lets the plane add rows without waiting on a release.
    for (const m of ["seedance", "kling", "google-veo", "image-generate"]) {
      expect(publishedToTenants(), m).toContain(m);
      expect(CATALOG, m).not.toContain(m);
    }
  });

  it("what module-readiness covers is a STRICT subset of the repo, and the page says so", () => {
    expect(CATALOG.length).toBeLessThan(ENTRIES.length);
    const doc = readFileSync(DOC, "utf8");
    // The denominator has to appear in the prose, not only in a table cell a reader can skim past.
    // Historical cf#295 figure stays; live population is "7 of N" with N = ENTRIES.
    expect(doc).toContain("6 of 26");
    expect(doc).toMatch(/7 of \d+/);
    expect(doc).toContain(`**${ENTRIES.length}**`);
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
