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
 * alternative is a document that quietly stops being true.
 *
 * THAT CONSEQUENCE WAS UNDER-STATED, AND THIS IS THE CORRECTION (vivijure#830). "The remedy is a
 * one-row edit" is what this header used to say, and it is wrong in a way that matters: the row lives
 * in ANOTHER REPO, so the two edits cannot be atomic and EVERY order goes red mid-flight. Retiring
 * hub-first leaves a module with no row; cf-first leaves a row with no module; adding does the same in
 * mirror image. Worse, the red lands on UNRELATED PRs, because this gate reads the hub at `main` and
 * so fails for a condition that is not in their diff. A check that can freeze merges over something
 * outside the change is the shape this estate refuses everywhere else.
 *
 * A bidirectional consistency gate across two repos cannot be satisfied atomically, so it must
 * tolerate ONE DECLARED transitional state or it forbids the transition it exists to keep honest.
 * That declaration is scripts/matrix-transition.txt, and it is deliberately hard to abuse: every
 * entry is printed, must name something present on at least one side, must appear in the hub's
 * `## Retired` section once its row is gone, and is a hard FAIL once its transition COMPLETES. An
 * exemption that cannot be left behind is not a hiding place.
 *
 * Usage:  node scripts/check-capability-matrix.mjs
 * Env:    MATRIX_SOURCE_URL   override the authority URL (the resolved value is printed)
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";

const DEFAULT_URL =
  "https://raw.githubusercontent.com/skyphusion-labs/vivijure/main/docs/CAPABILITIES.md";
const SOURCE_URL = process.env.MATRIX_SOURCE_URL || DEFAULT_URL;

const TRANSITION_FILE = "scripts/matrix-transition.txt";
const DIRECTIONS = new Set(["retiring", "adding"]);

/**
 * Declared transitions, parsed strictly. A malformed line is a FAILURE, never a skipped line: a
 * lenient parser here would silently drop an exemption and reintroduce the deadlock it exists to
 * remove, and it would do it in the direction that looks like the gate working.
 */
export function parseTransitions(text) {
  const out = [];
  const errors = [];
  const lines = (text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split(/\s+/);
    if (parts.length !== 3) {
      errors.push(`line ${i + 1}: expected "<module> <retiring|adding> <issue>", got ${parts.length} field(s): ${t}`);
      continue;
    }
    const [name, direction, issue] = parts;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) errors.push(`line ${i + 1}: "${name}" is not a module-name shape`);
    if (!DIRECTIONS.has(direction)) errors.push(`line ${i + 1}: "${direction}" is not retiring|adding`);
    if (!/^(cf|cp|vivijure)#[0-9]+$/.test(issue)) errors.push(`line ${i + 1}: "${issue}" is not an issue reference`);
    if (errors.length === 0 || errors[errors.length - 1].indexOf(`line ${i + 1}:`) !== 0) {
      out.push({ name, direction, issue });
    }
  }
  return { transitions: out, errors };
}

/**
 * Module names the hub lists as RETIRED. The Retired table's cells are prose, so parseMatrixModules
 * deliberately skips them and they are NOT part of the population; this reads them on purpose, as the
 * evidence that a removed capability was recorded rather than erased.
 */
export function parseRetiredNames(markdown) {
  const at = markdown.search(/^##\s+Retired\s*$/m);
  if (at < 0) return [];
  return [...markdown.slice(at).matchAll(/`([a-z0-9][a-z0-9-]*)`/g)].map((m) => m[1]);
}

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

/** The files that make a directory a MODULE. Shared with declaredHookCount below on purpose: the
 *  population and the hook count must agree on what a module is, or they describe different sets. */
export const MODULE_ENTRY_FILES = ["src/index.ts", "src/manifest.ts"];

/** True when this directory actually contains a module, not merely a directory that is named like one.
 *
 *  WHY THIS IS NOT PARANOIA (vivijure#831). Git does not track empty directories, so when a module's
 *  tracked files are removed by a merge, `git pull` leaves the parent directory behind. The tree is
 *  then WRONG in a way no git instrument will tell you about: `git status` is clean, `git ls-files`
 *  lists nothing, `git check-ignore` says not-ignored. `readdirSync` still counts it, so this gate
 *  reports modules that do not exist and fails LOCALLY while CI, which is a fresh checkout, is green.
 *  A developer cannot debug that with git, because every git command agrees the tree is correct.
 *
 *  Measured 2026-09-27: `finish-lipsync` and `speech-upscale` survived as empty directories in a
 *  clone after their retirement merges, and produced exactly that unexplainable local red.
 *
 *  `exists` is injected so the rule can be driven to both answers in a test without touching disk. */
export function isModuleDirectory(name, exists) {
  if (name.startsWith("_")) return false;
  return MODULE_ENTRY_FILES.some((f) => exists(`modules/${name}/${f}`));
}

function realModules() {
  return readdirSync("modules", { withFileTypes: true })
    .filter((e) => e.isDirectory() && isModuleDirectory(e.name, existsSync))
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
  for (const rel of MODULE_ENTRY_FILES.map((f) => `modules/${name}/${f}`)) {
    if (!existsSync(rel)) continue;
    const m = readFileSync(rel, "utf8").match(/hooks:\s*\[([^\]]*)\]/);
    if (!m) continue;
    const n = [...m[1].matchAll(/["'\x60]([a-z.]+)["'\x60]/g)].length;
    if (n > 0) return n;
  }
  return 1;
}

/**
 * THE GATE'S ENTIRE JUDGEMENT, PURE (vivijure#830).
 *
 * Extracted from main() so it can be driven to FAILURE in a test. Before this, the only way to
 * exercise the gate was to point it at the live hub and hope the state of two repos happened to
 * express the case you wanted, which means the widening added for transitions could not be shown to
 * still catch anything. A control that can only observe agreement is decoration.
 *
 * I/O stays in main(): this takes the already-read populations and returns problems + exemptions.
 */
export function evaluateMatrix({ actual, declared, appearances, transitions, retired, hookCount }) {
  const problems = [];
  const notes = [];
  const exempt = new Set();

  for (const t of transitions) {
    const inRepo = actual.includes(t.name);
    const inMatrix = declared.has(t.name);
    const where = `${inRepo ? "in modules/" : "NOT in modules/"}, ${inMatrix ? "in the matrix" : "NOT in the matrix"}`;

    // COMPLETED transitions are a hard failure, not a no-op. This is the whole reason an exemption
    // cannot be left behind, and it is the only thing between this file and a hiding place.
    if (t.direction === "retiring" && !inRepo && !inMatrix) {
      problems.push(
        `${TRANSITION_FILE} still lists "${t.name}" as retiring (${t.issue}) but the retirement is ` +
          `COMPLETE (${where}). Delete the line; a spent exemption is a standing hole.`,
      );
      continue;
    }
    if (t.direction === "adding" && inRepo && inMatrix) {
      problems.push(
        `${TRANSITION_FILE} still lists "${t.name}" as adding (${t.issue}) but the addition is ` +
          `COMPLETE (${where}). Delete the line; a spent exemption is a standing hole.`,
      );
      continue;
    }
    if (!inRepo && !inMatrix) {
      problems.push(
        `${TRANSITION_FILE} lists "${t.name}" (${t.direction}, ${t.issue}) and it exists on NEITHER ` +
          `side, so it exempts nothing and describes nothing. Remove it.`,
      );
      continue;
    }
    // A capability may LEAVE the matrix only into the Retired section. Vanishing outright is exactly
    // the failure this gate exists to catch, and a transition entry must not become the quiet way.
    if (t.direction === "retiring" && !inMatrix && !retired.includes(t.name)) {
      problems.push(
        `"${t.name}" is retiring (${t.issue}) and its matrix row is gone, but it is not named in the ` +
          `hub's "## Retired" section. Record the retirement there instead of erasing the capability.`,
      );
      continue;
    }
    exempt.add(t.name);
    notes.push(`TRANSITION ${t.name} (${t.direction}, ${t.issue}) -- ${where}; exempted`);
  }

  const missing = actual.filter((n) => !declared.has(n) && !exempt.has(n));
  const unknown = [...declared].filter((n) => !actual.includes(n) && !exempt.has(n)).sort();

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
    .filter(([n, c]) => actual.includes(n) && c > hookCount(n))
    .map(([n, c]) => `${n} (${c} rows, ${hookCount(n)} hook(s))`)
    .sort();
  if (overCounted.length) {
    problems.push(
      `${overCounted.length} module(s) appear in more matrix rows than they declare hooks, so a ` +
        `capability is crediting a provider that does not serve it: ${overCounted.join(", ")}`,
    );
  }

  return { problems, exempt, notes };
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

  let transitions = [];
  if (existsSync(TRANSITION_FILE)) {
    const parsed = parseTransitions(readFileSync(TRANSITION_FILE, "utf8"));
    if (parsed.errors.length) {
      for (const e of parsed.errors) console.error(`check-capability-matrix: FAIL -- ${TRANSITION_FILE} ${e}`);
      die(`${TRANSITION_FILE} has ${parsed.errors.length} malformed line(s); a dropped exemption reads as the gate working`);
    }
    transitions = parsed.transitions;
  }
  const retired = parseRetiredNames(body);
  const { problems, exempt, notes } = evaluateMatrix({
    actual,
    declared,
    appearances,
    transitions,
    retired,
    hookCount: declaredHookCount,
  });
  for (const n of notes) console.log(`check-capability-matrix: ${n}`);
  console.log(
    `check-capability-matrix: ${actual.length} modules on disk, ` +
      `${declared.size} named in ${rows} matrix rows, ` +
      `${exempt.size} in declared transition, ${retired.length} name(s) under Retired`,
  );

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
