// R2 render-orphan DRY-RUN REPORT (cf#1009). Deletes nothing and cannot: it reads three local inputs and
// writes a report. No R2 call, no network, no subprocess. tests/r2-render-orphan-report-1009.test.ts fails
// if a delete, a network call or a process spawn appears in this file or anything it imports.
//
// The rules are the core's (src/r2-render-orphan-reconcile.ts), the same ones scripts/r2-render-orphan-gc.ts
// applies: a key is an orphan only when NO live owner is found, and anything whose owner cannot be proven
// from records is out of scope. That is the "plus a real orphan sweep" half of the #779 code ruling.
//
// INPUTS, all produced read-only by the operator (exact commands: docs/1009-r2-render-orphan-gc.md):
//   --listing <file>  JSON lines, one object per line: {"key": "...", "size": N, "uploaded": "<ISO or ms>"},
//                     from a paginated S3 ListObjectsV2 of the bucket's renders/ prefix.
//   --owners <file>   the D1 owner snapshot, { "renderRows": [...], "shotRows": [...], "projectNames": [...] },
//                     the same file scripts/r2-render-orphan-gc.ts takes.
//   --docs <dir>      the live job docs the owner set names, each at <dir>/<its key>. A doc the listing holds
//                     but <dir> does not is MISSING: the run stops and prints the keys, and reports nothing,
//                     because an owner it cannot read would turn a live tree into an orphan.
// Options: --needed-docs (print the docs to fetch, then stop), --out <file> (full JSON report),
//          --grace-hours N (default 48), --max-objects N (default 200000), --now <ISO> (default: now).
//
//   node scripts/r2-render-orphan-report.ts --listing L.jsonl --owners O.json --docs D/ --needed-docs
//   node scripts/r2-render-orphan-report.ts --listing L.jsonl --owners O.json --docs D/ --out R.json
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildDryRunReport,
  buildRenderOwnerIndex,
  DEFAULT_GRACE_MS,
  parseListingLines,
  reconcileRenders,
  refuseOversizedSweep,
} from "../src/r2-render-orphan-reconcile.ts";
import type { RenderKeyRow, ShotKeyRow } from "../src/record-reclaim.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(msg: string, code = 2): never {
  console.error("error: " + msg);
  process.exit(code);
}

async function main(): Promise<void> {
  const listingPath = arg("--listing") ?? fail("--listing <jsonl> is required");
  const ownersPath = arg("--owners") ?? fail("--owners <json> is required");
  const docsDir = arg("--docs") ?? fail("--docs <dir> is required (it may be empty on the first --needed-docs pass)");
  const maxObjects = Number(arg("--max-objects") ?? 200000);
  const graceMs = arg("--grace-hours") ? Number(arg("--grace-hours")) * 3600 * 1000 : DEFAULT_GRACE_MS;
  const nowArg = arg("--now");
  const now = nowArg ? Date.parse(nowArg) : Date.now();
  if (!Number.isFinite(maxObjects) || maxObjects <= 0) fail("--max-objects must be a positive number");
  if (!Number.isFinite(graceMs) || graceMs < 0) fail("--grace-hours must be a number of hours, 0 or more");
  if (!Number.isFinite(now)) fail("--now must be an ISO time");

  const objects = parseListingLines(readFileSync(listingPath, "utf8"));
  const refusal = refuseOversizedSweep(objects.length, maxObjects);
  if (refusal) fail(refusal);
  const owners = JSON.parse(readFileSync(ownersPath, "utf8")) as { renderRows?: RenderKeyRow[]; shotRows?: ShotKeyRow[]; projectNames?: string[] };
  if (!Array.isArray(owners.renderRows) || !Array.isArray(owners.shotRows)) fail("--owners needs renderRows and shotRows arrays");

  // A doc the listing does not hold is absent (null). One it holds must be in --docs, else it is missing.
  const present = new Set(objects.map((o) => o.key));
  const missing: string[] = [];
  const idx = await buildRenderOwnerIndex({
    renderRows: owners.renderRows as RenderKeyRow[],
    shotRows: owners.shotRows as ShotKeyRow[],
    projectNames: owners.projectNames,
    readDoc: async (key) => {
      if (!present.has(key)) return null;
      const file = join(docsDir, key);
      if (!existsSync(file)) { missing.push(key); return null; }
      return JSON.parse(readFileSync(file, "utf8"));
    },
  });
  if (missing.length || process.argv.includes("--needed-docs")) {
    for (const k of missing) console.log(k);
    if (missing.length) {
      console.error(`${missing.length} live job doc(s) to fetch into ${docsDir}; fetch them and run again. No report was made.`);
      process.exit(3);
    }
    console.error("all needed docs are present");
    return;
  }

  const r = reconcileRenders(objects, idx, now, graceMs);
  const report = buildDryRunReport(r);
  const out = arg("--out");
  if (out) writeFileSync(out, JSON.stringify({ generatedAt: new Date(now).toISOString(), graceHours: graceMs / 3600000, ...report }, null, 1));

  const lines: string[] = [];
  lines.push(`## R2 render-orphan sweep: DRY RUN, nothing deleted`);
  lines.push("");
  lines.push(`Judged at ${new Date(now).toISOString()}, grace ${graceMs / 3600000} h. Owners: ${idx.liveJobIds.size} live job ids, ${idx.liveClipJobIds.size} live clip jobs, ${idx.referencedKeys.size} named keys, ${idx.docsRead} doc reads.`);
  lines.push("");
  lines.push(`Scanned ${report.scanned}: **would delete ${report.wouldDelete.count} (${report.wouldDelete.bytes} bytes)**, keep ${report.kept}, out of scope ${report.outOfScope}.`);
  lines.push("");
  lines.push("| decision | rule | objects | bytes |");
  lines.push("| --- | --- | --- | --- |");
  for (const s of report.rules) lines.push(`| ${s.decision === "orphan" ? "would delete" : s.decision} | \`${s.rule}\` | ${s.count} | ${s.bytes} |`);
  for (const s of report.rules) {
    lines.push("");
    lines.push(`### \`${s.rule}\` (${s.decision === "orphan" ? "would delete" : s.decision}), ${s.count} objects; first ${s.sample.length} by key`);
    lines.push("");
    for (const k of s.sample) lines.push(`- \`${k}\``);
  }
  console.log(lines.join("\n"));
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
