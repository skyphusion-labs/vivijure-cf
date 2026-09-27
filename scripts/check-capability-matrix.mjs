#!/usr/bin/env node
/**
 * vivijure#824: does the hub's capability matrix still describe the modules that actually exist?
 *
 * WHY THE CHECK LIVES HERE AND THE DOCUMENT LIVES THERE.
 * The matrix is at the hub (skyphusion-labs/vivijure, docs/CAPABILITIES.md) because that repo is
 * the declared constellation map. But the AUTHORITY for which modules exist is this repo's
 * modules/ directory, and the hub has no `ci` job to hang a gate on (vivijure#823). So the check
 * runs where the population is and fetches the claim, rather than the reverse. A checker that
 * carried its own copy of the module list could not detect that list changing -- the exact defect
 * cf#470 hit, and the reason scripts/check-tenant-module-catalog.mjs exists in the shape it does.
 * This is that shape, pointed at a document instead of at another repo's constant.
 *
 * WHAT IT CAN AND CANNOT SEE, because a gate that looks total is worse than one with a stated edge.
 * CAN: every module in modules/ appears in the matrix exactly once; no row names a module that does
 * not exist. CANNOT: whether the Status column is true, whether the promise wording is honest, or
 * whether a provider's endpoint is alive. Green here means the POPULATION matches. It does not mean
 * the film renders.
 *
 * CREDENTIAL-FREE BY CONSTRUCTION. Both repos are public, so this reads raw.githubusercontent.com
 * with no token and runs on fork PRs.
 *
 * FAILURE DIRECTION, DECIDED HERE RATHER THAN DISCOVERED LATER. Non-zero on a fetch error, a
 * non-200, an empty body, a parse that finds no rows, or a disagreement. It never degrades to a
 * skip. An instrument that cannot reach its subject reports the same shape as a subject that agrees
 * with you, and of those two only the reassuring one becomes a belief.
 *
 * CONSEQUENCE, STATED BEFORE SOMEBODY MEETS IT: adding or removing a module in this repo turns THIS
 * repo red until the matrix row lands at the hub. That is deliberate and it is the point: the
 * alternative is a document that quietly stops being true. The remedy is a one-row edit.
 *
 * Usage:  node scripts/check-capability-matrix.mjs
 * Env:    MATRIX_SOURCE_URL   override the authority URL (the resolved value is printed)
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";

const DEFAULT_URL =
  "https://raw.githubusercontent.com/skyphusion-labs/vivijure/main/docs/CAPABILITIES.md";
const SOURCE_URL = process.env.MATRIX_SOURCE_URL || DEFAULT_URL;

/** A cell that is a module list: backticked names and/or the literal `--`, comma separated. */
const MODULE_CELL = /^(?:`[a-z0-9][a-z0-9-]*`|--)(?:\s*,\s*(?:`[a-z0-9][a-z0-9-]*`|--))*$/;

function die(msg) {
  console.error(`check-capability-matrix: FAIL -- ${msg}`);
  process.exit(1);
}

/**
 * Pull module names out of the LAST cell of every markdown table row whose last cell is a module
 * list. Position-independent on purpose: the two tables have different column counts, and keying
 * on an index would break the day someone adds a column. Prose cells fail MODULE_CELL and are
 * skipped, which is how the Status legend and the Retired table stay out of the population.
 */
export function parseMatrixModules(markdown) {
  const found = [];
  let rows = 0;
  for (const line of markdown.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || !t.endsWith("|")) continue;
    const cells = t.slice(1, -1).split("|").map((c) => c.trim());
    if (cells.length < 2) continue;
    const last = cells[cells.length - 1];
    if (!MODULE_CELL.test(last)) continue;
    rows += 1;
    for (const m of last.matchAll(/`([a-z0-9][a-z0-9-]*)`/g)) found.push(m[1]);
  }
  return { found, rows };
}

function realModules() {
  return readdirSync("modules", { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort();
}

/**
 * How many hooks a module declares. A module may legitimately appear in one matrix row per hook:
 * `local-gpu` serves both `motion.backend` and `keyframe`, and it belongs in both of those
 * capability rows. The first version of this check asserted "exactly once" and its own positive
 * control caught that as a false failure against correct docs, so the ceiling is derived from the
 * manifest instead of assumed. Unknown (0 parsed) is treated as 1: the conservative direction is
 * to flag an extra appearance for a human, not to wave it through.
 */
function declaredHookCount(name) {
  for (const rel of [`modules/${name}/src/index.ts`, `modules/${name}/src/manifest.ts`]) {
    if (!existsSync(rel)) continue;
    const m = readFileSync(rel, "utf8").match(/hooks:\s*\[([^\]]*)\]/);
    if (!m) continue;
    const n = [...m[1].matchAll(/["'\x60]([a-z.]+)["'\x60]/g)].length;
    if (n > 0) return n;
  }
  return 1;
}

async function main() {
  console.log(`check-capability-matrix: authority = ${SOURCE_URL}`);

  let res;
  try {
    res = await fetch(SOURCE_URL, { headers: { "user-agent": "vivijure-capability-matrix-check" } });
  } catch (e) {
    die(`could not fetch the matrix: ${e && e.message ? e.message : e}`);
  }
  if (!res.ok) die(`matrix fetch returned HTTP ${res.status}`);

  const body = await res.text();
  if (!body || body.trim().length === 0) die("matrix fetched empty");

  const { found, rows } = parseMatrixModules(body);

  // Self-control: a parser that silently matches nothing agrees with every possible module set.
  if (rows === 0) die("parsed 0 module rows out of the matrix; the format changed or the fetch was wrong");
  if (found.length === 0) die(`parsed ${rows} module rows but extracted 0 module names`);

  const declared = new Set(found);
  const appearances = new Map();
  for (const n of found) appearances.set(n, (appearances.get(n) || 0) + 1);
  const actual = realModules();
  if (actual.length === 0) die("found no modules in modules/; refusing to compare against nothing");

  const missing = actual.filter((n) => !declared.has(n));
  const unknown = [...declared].filter((n) => !actual.includes(n)).sort();

  console.log(
    `check-capability-matrix: ${actual.length} modules on disk, ` +
      `${declared.size} named in ${rows} matrix rows`,
  );

  const problems = [];
  if (missing.length) {
    problems.push(
      `${missing.length} module(s) exist but are NOT in the matrix, so the docs are silently ` +
        `missing a capability: ${missing.join(", ")}`,
    );
  }
  if (unknown.length) {
    problems.push(
      `${unknown.length} module(s) named in the matrix do NOT exist, so the docs promise ` +
        `something no host can serve: ${unknown.join(", ")}`,
    );
  }
  const overCounted = [...appearances.entries()]
    .filter(([n, c]) => actual.includes(n) && c > declaredHookCount(n))
    .map(([n, c]) => `${n} (${c} rows, ${declaredHookCount(n)} hook(s))`)
    .sort();
  if (overCounted.length) {
    problems.push(
      `${overCounted.length} module(s) appear in more matrix rows than they declare hooks, so a ` +
        `capability is crediting a provider that does not serve it: ${overCounted.join(", ")}`,
    );
  }

  if (problems.length) {
    for (const p of problems) console.error(`check-capability-matrix: FAIL -- ${p}`);
    console.error(
      "check-capability-matrix: fix docs/CAPABILITIES.md in skyphusion-labs/vivijure, then re-run.",
    );
    process.exit(1);
  }

  console.log("check-capability-matrix: OK -- the matrix and modules/ agree.");
}

// Allow importing parseMatrixModules from a test without running the fetch.
if (process.argv[1] && process.argv[1].endsWith("check-capability-matrix.mjs")) {
  await main();
}
