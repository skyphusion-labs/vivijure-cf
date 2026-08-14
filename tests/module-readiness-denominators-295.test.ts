// THE DENOMINATOR IS THE FINDING (cf#295).
//
// cf#295 measured 6 of N modules implementing /ready and named the danger: a sweep that cannot
// tell "not ready" from "no endpoint exists" answers with the reassuring one. That is FIXED --
// every module implements it now, and tests/module-ready-coverage-291.test.ts holds that invariant.
// N is the modules/ tree size (see ENTRIES); it grows when new modules land.
//
// THE GAP MOVED RATHER THAN CLOSING, and this file is about where it moved to. `module-readiness`
// on the control plane iterates TENANT_MODULE_CATALOG, a strict subset of the tree. Every one of
// its members now answers 200, so the route looks complete while speaking for that subset. Before,
// an unimplemented sweep 404'd and the hole was visible in the result; now it is invisible unless
// somebody publishes the denominator. docs/module-readiness-coverage.md publishes it, and this file
// stops that page drifting away from the modules it describes -- a stale coverage table is the same
// defect the page exists to warn about.
//
// SCOPE, stated plainly. Three of the four populations are derived from THIS repo and are therefore
// really checked. The fourth (what the control plane provisions) lives in another repo, so it is
// MIRRORED here as data and checked against the authority OUT OF BAND -- see CATALOG below.
//
// cf#470: THAT FOURTH POPULATION USED TO BE A LITERAL IN THIS FILE, WITH ITS LENGTH ASSERTED
// AGAINST A NUMBER TYPED BESIDE IT. That is a test comparing a copy against itself: it cannot
// detect the population changing, it holds the stale value in place, and it goes RED if somebody
// corrects it. The catalog went 6 -> 7 -> 15 and nothing failed at any step. The number is not the
// defect; the shape is. Everything asserted about the catalog below is therefore a RELATION to
// something derived from this repo, never a count typed nearby.
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
 * Population 4: MIRRORED, and checked against the authority by a DIFFERENT instrument.
 *
 * TENANT_MODULE_CATALOG lives in vivijure-control-plane/src/tenant-modules.ts and this repo cannot
 * import it, so a copy has to exist. It lives in scripts/tenant-module-catalog.txt with its
 * provenance attached, and scripts/check-tenant-module-catalog.mjs -- a required CI step -- fetches
 * the plane's file over public HTTPS and asserts set-equality, failing closed on a fetch error or
 * an empty parse on either side.
 *
 * WHY THE CHECK IS NOT IN THIS FILE. An offline suite cannot reach the authority, so anything it
 * asserts about the catalog's CONTENTS is asserted about the copy. That was cf#470: `toBe(7)`
 * against a 7-element literal, green while the real value was 15, and red for anyone who fixed it.
 * cp#314 is the same class one repo over. The rule the two of them settle: DERIVE THE POPULATION,
 * NEVER THE EXPECTATION -- a loop's membership may come from the catalog, an answer may not.
 *
 * So this file asserts only RELATIONS between the mirror and things it can really measure: every
 * catalogued module exists in this repo, every catalogued module has a published bundle, and the
 * doc publishes this list's length. Each of those can go red on a wrong mirror. A length compared
 * to a number typed nearby cannot.
 */
function tenantCatalog(): string[] {
  const list = readFileSync(join(ROOT, "scripts", "tenant-module-catalog.txt"), "utf8")
    .split("\n").map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
  if (list.length === 0) throw new Error("tenant-module-catalog.txt parsed to nothing");
  return [...list].sort();
}

const CATALOG = tenantCatalog();

describe("the readiness denominator is published and does not drift (cf#295)", () => {
  it("the scan read the tree (positive control)", () => {
    // Every assertion below is shaped so that a scan reading NOTHING would produce empty sets and
    // pass. Pin real data with named members so a path or parse regression is loud.
    expect(ENTRIES.length).toBeGreaterThan(20);
    expect(READY).toContain("keyframe");
    expect(WRITES_JOB_LOG).toContain("finish-rife");
    expect(REPORTS_JOB_LOG).toContain("speech-upscale");
    expect(publishedToTenants()).toContain("plan-enhance");

    // cf#470: the catalog mirror is parsed, not typed. Prove the parser reads it AND that its
    // comment-stripping discriminates -- the file's provenance header contains module names in
    // prose, so a parser that kept `#` lines would return plausible extra members.
    expect(CATALOG).toContain("keyframe");
    expect(CATALOG).not.toContain("provenance:");
    expect(CATALOG.every((m) => /^[a-z0-9-]+$/.test(m)), "a mirror entry is not a module name").toBe(true);
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
    expect(WRITES_JOB_LOG.length).toBe(15);
    for (const m of ["seedance", "kling", "vidu-q3", "google-veo", "minimax-hailuo", "alibaba-wan", "alibaba-wan-lora", "narration-gen"]) {
      expect(WRITES_JOB_LOG, "cost-door module not recording: " + m).toContain(m);
    }
  });

  it("the four populations are the sizes the published table claims", () => {
    // 31 = main's 27 (26 base + finish-blender, cf#470) + 4 new CF AI i2v modules
    // (cf-hh1-r2v, cf-seedance, cf-grok-video, cf-flux-3-video). Recomputed against the
    // merged tree, not summed from either branch in isolation (the dispatch's own "26->30"
    // arithmetic missed main's independent finish-blender addition).
    expect(ENTRIES.length).toBe(31);
    // main already corrected this 14 -> 15 (cf#470 / cf#305: the eight cost-door submitters).
    // The four new i2v modules are CF AI Gateway backed, not RunPod: none call recordRunpodJob
    // or report telemetry.job_log (verified against the merged module sources), so the
    // population this counts is unchanged by this PR and 15 stands.
    expect(WRITES_JOB_LOG.length).toBe(15);
    // cf#394 moved this from 7 to 16: the 8 cost-door modules and image-generate now publish a
    // tenant bundle. cf#396 moved it 16 -> 20 with the four own-iron finishing modules
    // (audio-master, beat-sync, film-titles, subtitle). A bundle with no catalog row uploads
    // nothing, so publishing is inert until the plane adds rows; it exists to remove the
    // cross-repo serialisation, not to change behaviour.
    expect(publishedToTenants().length).toBe(20);
    // NO `expect(CATALOG.length).toBe(N)` HERE, DELIBERATELY (cf#470). CATALOG is now read from
    // the mirror, so any number asserted against it is asserted against the same file -- the
    // tautology this issue is about, reintroduced under a new name. The mirror's contents are
    // checked by scripts/check-tenant-module-catalog.mjs against the plane; its length is
    // published in the doc and asserted below, where the two artifacts can disagree.
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

    // cf#394 published nine modules ahead of the catalog; cp#317 has since catalogued eight of
    // them. cf#396 then published the four own-iron finishing modules ahead of the catalog for a
    // DIFFERENT reason, so the set now has two distinct causes and neither is drift:
    //
    //   - `image-generate` -- gated on #401, because it reads OPENAI_API_KEY, an operator-scoped
    //     credential.
    //   - `audio-master`, `beat-sync`, `film-titles`, `subtitle` -- each reaches the finishing
    //     swarm over a Workers VPC service binding, and `uploadTenantModules` binds no
    //     `vpc_service` (measured: zero occurrences of "vpc" in the plane's tenant-modules.ts,
    //     against a matcher proven on three sibling files). Catalogue them before that exists and
    //     three degrade to a tagged passthrough while `beat-sync` returns ok:false on every score
    //     invoke. Published first so the bundles exist; the row waits on the binding.
    //
    // ASSERTED AS A SET DIFFERENCE, not as a hand-listed loop (cp#314). A loop over names somebody
    // typed re-encodes the same stale list this file was fixed for: it keeps passing as the two
    // populations move, and reports nothing about the members nobody thought to add.
    const publishedNotProvisioned = publishedToTenants().filter((m) => !CATALOG.includes(m));
    expect(publishedNotProvisioned).toEqual([
      "audio-master",
      "beat-sync",
      "film-titles",
      "image-generate",
      "subtitle",
    ]);
    for (const m of ["seedance", "kling", "google-veo"]) {
      expect(publishedToTenants(), m).toContain(m);
      expect(CATALOG, m).toContain(m);
    }
  });

  it("what module-readiness covers is a STRICT subset of the repo, and the page says so", () => {
    // cf#470: `CATALOG.length < ENTRIES.length` was the assertion here and it is green across the
    // entire range the error can occupy -- 7 < 27 passes and 15 < 27 passes, so it could only fail
    // if the catalog exceeded the whole tree. Replaced with the containment it was gesturing at,
    // which names the offender when it breaks.
    const names = new Set(ENTRIES.map((e) => e.name));
    const notInRepo = CATALOG.filter((m) => !names.has(m));
    expect(notInRepo, "catalogued module(s) this repo does not ship").toEqual([]);
    // The old `toBeLessThan` is NOT kept alongside it. Describing an assertion as incapable of
    // failing and then leaving it in place is the same defect wearing a disclaimer.

    const doc = readFileSync(DOC, "utf8");
    // The denominator has to appear in the prose, not only in a table cell a reader can skim past,
    // and it is DERIVED from both populations rather than typed -- so correcting the mirror
    // without correcting the page is red.
    expect(doc).toContain(`${CATALOG.length} of ${ENTRIES.length}`);
  });

  it("every PROVISIONED module has a PUBLISHED bundle (cp#187 assertion A, from this side)", () => {
    // A catalog row with no bundle in the release fails EVERY provision at modules_upload. The
    // plane gates this at deploy against the release artifact; this is the same invariant asserted
    // where the bundle list actually lives, so the ordering error is visible on the PR that
    // introduces it rather than at the next tenant.
    const published = new Set(publishedToTenants());
    const unpublished = CATALOG.filter((m) => !published.has(m));
    expect(unpublished, "provisioned module(s) with no published tenant bundle").toEqual([]);
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
