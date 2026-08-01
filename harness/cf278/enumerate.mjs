#!/usr/bin/env node
// cf#278 phase 1 -- coverage enumerator.
//
// WHY THIS EXISTS. "Every feature" has to come from an inventory the system itself publishes, not
// from a list a human maintains, or the harness silently passes on the day someone adds a feature.
//
// TWO INVENTORIES, NOT ONE. The module registry (`GET /api/modules`) is authoritative for MODULES
// and is not authoritative for FEATURES. Cast LoRA training is a CORE action in
// @skyphusion-labs/vivijure-core reached via RUNPOD_WAN_TRAIN_ENDPOINT_ID; it has no registry entry.
// Enumerating the registry alone would report full coverage while never touching the wan-train
// endpoint, which is one of the three endpoints cf#277 is about. So: registry UNION core actions.
//
// FAILS LOUD on any entry in either inventory with no declared coverage. Exit 2 = uncovered.
// Exit 3 = the enumeration itself could not be trusted (empty inventory, unreachable registry).
// An empty inventory is a FAILING answer, never a passing one.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const STUDIO = process.env.VJ_STUDIO_URL || "https://vivijure.skyphusion.org";
const TOKEN = process.env.VJ_STUDIO_TOKEN || "";
const CORE_DIST = process.env.VJ_CORE_DIST ||
  "node_modules/@skyphusion-labs/vivijure-core/dist";

// ---------------------------------------------------------------- inventory A: the live registry
async function liveRegistry() {
  // FILE MODE: used only when no studio token is held. It MUST announce itself, because a
  // registry read from a file and a registry read from the live studio are indistinguishable in
  // the output otherwise, and one of them proves reachability while the other proves nothing.
  if (process.env.VJ_REGISTRY_FILE) {
    const reg = JSON.parse(readFileSync(process.env.VJ_REGISTRY_FILE, "utf8"));
    const modules = (reg.modules || []).map((m) => m.name);
    if (modules.length === 0) throw new Error("supplied registry has ZERO modules");
    const hookPairs = [];
    for (const [hook, names] of Object.entries(reg.hooks || {})) for (const n of names) hookPairs.push(`${hook}:${n}`);
    console.log(`REGISTRY SOURCE: FILE ${process.env.VJ_REGISTRY_FILE} -- NOT a live fetch; proves inventory, proves nothing about reachability`);
    return { modules, hookPairs, raw: reg };
  }
  const headers = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
  const res = await fetch(`${STUDIO}/api/modules`, { headers });
  if (!res.ok) {
    throw new Error(`registry unreachable: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  console.log(`REGISTRY SOURCE: LIVE ${STUDIO}`);
  const reg = await res.json();
  const modules = (reg.modules || []).map((m) => m.name);
  if (modules.length === 0) {
    throw new Error("registry returned ZERO modules -- refusing to treat an empty inventory as coverage");
  }
  // Hooks matter independently: a module can serve a hook nothing exercises.
  const hookPairs = [];
  for (const [hook, names] of Object.entries(reg.hooks || {})) {
    for (const n of names) hookPairs.push(`${hook}:${n}`);
  }
  return { modules, hookPairs, raw: reg };
}

// ------------------------------------------------------- inventory B: core actions, DERIVED not typed
// Read the action literals the core actually submits, so a new core action appears here without
// anyone editing this file. This is the whole point: a hand-maintained list is the failure mode.
function coreActions(distDir) {
  // SCOPED to the GPU submit module on purpose. A repo-wide scan for `action:` also matches a retry
  // policy object ({action:"retry"}/{action:"fail"}), which is not a GPU action at all -- the first
  // version of this function invented four actions that do not exist AND missed two that do.
  // TWO SYNTACTIC FORMS, because the code uses both: an object literal `action: "finalize"` and an
  // assignment `input.action = "preview"`. Matching only the first silently loses `preview`.
  const file = join(distDir, "runpod-submit.js");
  let src;
  try { src = readFileSync(file, "utf8"); }
  catch (e) { throw new Error(`core submit module unreadable at ${file}: ${e.message}`); }

  const found = new Set();
  for (const re of [/\baction:\s*"([a-z0-9_]+)"/g, /\.action\s*=\s*"([a-z0-9_]+)"/g]) {
    let m;
    while ((m = re.exec(src)) !== null) found.add(m[1]);
  }

  // POSITIVE CONTROL on the matcher itself. These are known to exist; if the dist shape changes and
  // the regexes stop matching, this fails loudly instead of reporting a smaller, cleaner inventory.
  // A shrinking inventory is the dangerous direction: it makes coverage look COMPLETE.
  const MUST_FIND = ["finalize", "regen_shot", "train_lora", "preview"];
  const missing = MUST_FIND.filter((a) => !found.has(a));
  if (missing.length) {
    throw new Error(`core-action matcher is broken: expected ${MUST_FIND.join(", ")} but did not find ${missing.join(", ")}`);
  }
  // `render` is the default action and is not always written as a literal; it is a real action and
  // is asserted here rather than discovered, with the reason stated so it is not mistaken for derived.
  found.add("render");
  return [...found].sort();
}

// ------------------------------------------------------------------------- declared coverage
// The ONLY hand-written thing here, and deliberately so: it is a list of what the harness CLAIMS to
// cover. Anything in an inventory but absent here fails loud. Adding a feature therefore breaks the
// build until someone either covers it or explicitly records it as a known gap with a reason.
const COVERED = new Set(JSON.parse(
  process.env.VJ_COVERAGE_JSON || readFileSync(new URL("./coverage.json", import.meta.url), "utf8"),
).covered);
const KNOWN_GAPS = JSON.parse(
  process.env.VJ_COVERAGE_JSON || readFileSync(new URL("./coverage.json", import.meta.url), "utf8"),
).known_gaps || {};

function main(reg, actions) {
  const inventory = [
    ...reg.modules.map((m) => ({ kind: "module", id: m })),
    ...reg.hookPairs.map((h) => ({ kind: "hook", id: h })),
    ...actions.map((a) => ({ kind: "core-action", id: a })),
  ];

  const uncovered = [];
  const gapped = [];
  for (const item of inventory) {
    const key = `${item.kind}:${item.id}`;
    if (COVERED.has(key)) continue;
    if (KNOWN_GAPS[key]) { gapped.push({ ...item, reason: KNOWN_GAPS[key] }); continue; }
    uncovered.push(item);
  }

  // Print the DENOMINATOR every time. A filter that excluded everything must be visible as such.
  console.log(`inventory: ${reg.modules.length} modules, ${reg.hookPairs.length} hook bindings, ${actions.length} core actions (total ${inventory.length})`);
  console.log(`covered: ${inventory.length - uncovered.length - gapped.length}  known-gap: ${gapped.length}  UNCOVERED: ${uncovered.length}`);
  console.log(`core actions derived: ${actions.join(", ")}`);

  if (gapped.length) {
    console.log("\nKNOWN GAPS (explicitly recorded, not silently passed):");
    for (const g of gapped) console.log(`  ${g.kind}:${g.id} -- ${g.reason}`);
  }
  if (uncovered.length) {
    console.error("\nUNCOVERED ENTRIES -- this is the gap this phase exists to find:");
    for (const u of uncovered) console.error(`  ${u.kind}:${u.id}`);
    process.exit(2);
  }
  console.log("\nall inventory entries are covered or explicitly gapped");
}

try {
  const reg = await liveRegistry();
  const actions = coreActions(CORE_DIST);
  main(reg, actions);
} catch (e) {
  console.error(`ENUMERATION FAILED (state UNKNOWN, NOT assumed clean): ${e.message}`);
  process.exit(3);
}
