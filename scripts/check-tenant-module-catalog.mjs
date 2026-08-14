#!/usr/bin/env node
/**
 * cf#470: does this repo's mirror of TENANT_MODULE_CATALOG still match the control plane?
 *
 * WHY THIS IS A SEPARATE SCRIPT AND NOT AN ASSERTION IN THE VITEST SUITE.
 * The authority lives in another repo. A test that carries its own copy of the population it is
 * testing cannot detect that population changing: it passes forever and reads as coverage. The
 * catalog went 6 -> 7 -> 15 with a length assertion pinned to the copy at every step, and nothing
 * failed once. So the copy stays (scripts/tenant-module-catalog.txt, because this repo genuinely
 * cannot import the other one) and the CHECK moved to the only place that can fail: a fetch of the
 * authority.
 *
 * CREDENTIAL-FREE BY CONSTRUCTION. vivijure-cf, vivijure-control-plane and vivijure-core are all
 * public, so this reads raw.githubusercontent.com with no token and runs on fork PRs. That is the
 * same property the plane's own cross-repo gate (check-release-modules.py) is built around.
 *
 * FAILURE DIRECTION, DECIDED HERE RATHER THAN DISCOVERED LATER. This exits NON-ZERO on a fetch
 * error, an empty parse on either side, or a control that does not fire. It never degrades to a
 * skip. An instrument that cannot reach its subject reports the same shape as a subject that
 * agrees with you, and of the two possible directions only the reassuring one becomes a belief.
 * The cost of the alarming direction is one look; the cost of the reassuring one is cf#470 again.
 *
 * CONSEQUENCE WORTH STATING BEFORE SOMEBODY MEETS IT: this is a step of the required `ci` job, so
 * a catalog change in the plane turns THIS repo red, including on pull requests that have nothing
 * to do with modules. That is deliberate. The remedy is a one-line edit to the mirror plus the
 * population-4 numbers in docs/module-readiness-coverage.md, which is the work the drift was
 * hiding. A non-blocking version of this check is a cross-reference, not a control.
 *
 * Usage:  node scripts/check-tenant-module-catalog.mjs
 * Env:    CATALOG_SOURCE_URL   override the authority URL (no fallback; the resolved value is
 *                              printed next to the verdict so a run can be audited afterwards)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR = join(ROOT, "scripts", "tenant-module-catalog.txt");
const DEFAULT_SOURCE =
  "https://raw.githubusercontent.com/skyphusion-labs/vivijure-control-plane/main/src/tenant-modules.ts";
const SOURCE = process.env.CATALOG_SOURCE_URL || DEFAULT_SOURCE;

const OPEN = /^export const TENANT_MODULE_CATALOG\b.*\[\s*$/;
const CLOSE = /^\];\s*$/;
const ENTRY = /^\s*\{\s*module:\s*"([a-z0-9-]+)"/;

function fail(msg) {
  console.error("FAIL (cf#470 catalog drift check): " + msg);
  console.error("  source: " + SOURCE);
  process.exit(1);
}

/**
 * Extract by the array's BOUNDS, never by counting `module:` matches in a window someone chose.
 * The plane's file carries that token outside the array; a window is a matcher too, and the
 * window is the one denominator nobody prints.
 */
function extractCatalog(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => OPEN.test(l));
  if (start < 0) return { names: [], reason: "no TENANT_MODULE_CATALOG array opener" };
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => CLOSE.test(l));
  if (end < 0) return { names: [], reason: "array opener found but no closing `];`" };
  const names = [];
  for (const line of rest.slice(0, end)) {
    const m = ENTRY.exec(line);
    if (m) names.push(m[1]);
  }
  return { names: names.sort(), reason: null, sliceLines: end, fileLines: lines.length };
}

function parseMirror(text) {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"))
    .sort();
}

function diff(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  return {
    onlyA: a.filter((x) => !B.has(x)),
    onlyB: b.filter((x) => !A.has(x)),
  };
}

// ---------------------------------------------------------------------------
// CONTROLS FIRST, THEN THE CLAIM. Run before anything is fetched, so a control that cannot fire
// stops the run instead of arriving as an awkward line under a result already written.
// ---------------------------------------------------------------------------
function selfTest() {
  const failures = [];

  // NEGATIVE CONTROL 1: the comparator must report a planted difference in each direction.
  const base = ["alpha", "beta"];
  const missing = diff(base, ["alpha"]);
  if (missing.onlyA.length !== 1) failures.push("comparator did not report a missing element");
  const extra = diff(base, ["alpha", "beta", "gamma"]);
  if (extra.onlyB.length !== 1) failures.push("comparator did not report an extra element");
  const same = diff(base, ["beta", "alpha"]);
  if (same.onlyA.length || same.onlyB.length) failures.push("comparator reported a false difference");

  // NEGATIVE CONTROL 2: the extractor must REJECT a `module:` line outside the array bounds.
  // This is the near-miss that makes a naive `grep -c 'module:'` wrong on the real file.
  const fixture = [
    '  { module: "decoy-before", endpointKey: "x" },',
    'export const TENANT_MODULE_CATALOG: readonly TenantModuleSpec[] = [',
    '  { module: "inside-one", endpointKey: "x" },',
    '  // { module: "commented-out" },',
    '  { module: "inside-two", needsAiGateway: true },',
    '];',
    '  { module: "decoy-after", endpointKey: "x" },',
  ].join("\n");
  const got = extractCatalog(fixture).names;
  // POSITIVE half: it finds what is inside.
  if (got.join(",") !== "inside-one,inside-two") {
    failures.push("extractor returned [" + got.join(",") + "], expected inside-one,inside-two");
  }

  // NEGATIVE CONTROL 3: an input with no array must yield EMPTY, not a plausible list.
  const none = extractCatalog('const x = 1;\n  { module: "stray" },\n');
  if (none.names.length !== 0) failures.push("extractor invented entries from a file with no array");

  if (failures.length) {
    console.error("FAIL: the check's own controls did not fire. The instrument is the finding.");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
  console.log("controls: comparator reports both directions; extractor rejects 3 decoys; empty input yields 0");
}

async function main() {
  selfTest();

  const mirror = parseMirror(readFileSync(MIRROR, "utf8"));
  if (mirror.length === 0) fail("the mirror parsed to nothing (" + MIRROR + ")");

  let body;
  try {
    const res = await fetch(SOURCE, { headers: { "user-agent": "vivijure-cf-catalog-check" } });
    if (!res.ok) fail("fetch returned HTTP " + res.status + " -- CANNOT VERIFY, not agreement");
    body = await res.text();
  } catch (err) {
    fail("fetch failed (" + err.message + ") -- CANNOT VERIFY, not agreement");
  }

  if (!body || !body.includes("TENANT_MODULE_CATALOG")) {
    fail("fetched " + (body ? body.length : 0) + " bytes with no TENANT_MODULE_CATALOG in them");
  }

  const { names: remote, reason, sliceLines, fileLines } = extractCatalog(body);
  if (reason) fail("could not bound the array: " + reason);
  if (remote.length === 0) fail("the authority parsed to ZERO entries -- treat as instrument failure");

  // DENOMINATORS, PRINTED AND NOT GATED ON, and the distinction was earned the hard way.
  //
  // The first version of this check GATED on "the bounded slice must be smaller than the
  // whole-file count of `module: \"`". It failed on its first live run -- both numbers are 15,
  // because every QUOTED `module:` in that file happens to sit inside the array. The gate could
  // not tell "the bounds worked and everything is inside" from "the bounds failed", which is the
  // exact defect it was written to catch, rebuilt inside itself. A gate whose premise is an
  // incidental property of today's authority file goes red on a healthy plane tomorrow.
  //
  // Bounding is proved instead by the CONSTRUCTED fixture in selfTest(), which plants decoy
  // `module:` lines before the opener and after the closer and requires the extractor to reject
  // both. That control runs every time and cannot go stale. These numbers are reported so a
  // reader can audit the run afterwards: the LOOSE count is what a naive `grep -c 'module:'`
  // would have returned, and the gap between it and the slice is why the bounds exist at all.
  const looseCount = (body.match(/\bmodule:/g) || []).length;
  const quotedCount = (body.match(/\bmodule:\s*"/g) || []).length;

  const { onlyA: onlyMirror, onlyB: onlyRemote } = diff(mirror, remote);
  console.log("source:    " + SOURCE);
  console.log(
    "authority: " + remote.length + " entries in the bounded array (lines " + sliceLines +
      " of " + fileLines + "); the file carries " + quotedCount + " quoted and " + looseCount +
      " total `module:` occurrences",
  );
  console.log("mirror:    " + mirror.length + " entries in scripts/tenant-module-catalog.txt");

  if (onlyMirror.length || onlyRemote.length) {
    console.error("");
    console.error("FAIL: TENANT_MODULE_CATALOG has drifted from the mirror in this repo.");
    if (onlyRemote.length) console.error("  in the plane, NOT in the mirror: " + onlyRemote.join(", "));
    if (onlyMirror.length) console.error("  in the mirror, NOT in the plane: " + onlyMirror.join(", "));
    console.error("");
    console.error("  Fix: edit scripts/tenant-module-catalog.txt to match, update its provenance");
    console.error("  header, and correct the population-4 numbers in docs/module-readiness-coverage.md.");
    process.exit(1);
  }

  console.log("OK: the mirror matches the plane's TENANT_MODULE_CATALOG, " + remote.length + " entries.");
}

await main();
