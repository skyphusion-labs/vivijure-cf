// R2 RENDER-orphan GC: IO glue around the pure core (cf#1009). The rules, and what is deliberately
// out of scope, are in src/r2-render-orphan-reconcile.ts; read that header before running this.
//
// Enumerates renders/ with rclone, builds the owner index from a D1 snapshot plus the live job docs it
// names, and either REPORTS the orphan set (the default, a dry run) or deletes it (--apply), with
// per-delete logging and a re-list verification pass. It refuses up front, deleting nothing, when the
// listing is over --max-objects, and it aborts, deleting nothing, if any live job doc cannot be read.
//
// The owner snapshot is a JSON file, so the exact set a run judged against is recorded beside its
// report. Build it from the three queries the core exports (RENDER_OWNER_SQL, SHOT_OWNER_SQL,
// PROJECT_NAME_SQL), each with `wrangler d1 execute <db> --remote --json --command "<sql>"`, as
//   { "renderRows": [...], "shotRows": [...], "projectNames": ["..."] }
// Take the snapshot immediately before the run: a row created after it reads as dead, and only the
// grace window (default 48 h, --grace-hours) protects that new work.
//
// Run (dry run):  node scripts/r2-render-orphan-gc.ts --owners <snapshot.json>
// Apply:          node scripts/r2-render-orphan-gc.ts --owners <snapshot.json> --apply
// R2 is an rclone remote (default "r2", bucket "vivijure"); set R2_REMOTE / R2_BUCKET to override.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  buildRenderOwnerIndex,
  clipJobOwnerMarkerOf,
  DEFAULT_GRACE_MS,
  jobKindOf,
  reconcileRenders,
  refuseOversizedSweep,
  type RenderObjectLite,
} from "../src/r2-render-orphan-reconcile.ts";
import type { RenderKeyRow, ShotKeyRow } from "../src/record-reclaim.ts";

const REMOTE = process.env.R2_REMOTE || "r2";
const BUCKET = process.env.R2_BUCKET || "vivijure";
const PREFIX = "renders/";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const MAX_OBJECTS = Number(arg("--max-objects") ?? 200000);
const GRACE_MS = arg("--grace-hours") ? Number(arg("--grace-hours")) * 3600 * 1000 : DEFAULT_GRACE_MS;

function rclone(args: string[]): string {
  return execFileSync("rclone", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function listRenders(): RenderObjectLite[] {
  const rows = JSON.parse(rclone(["lsjson", "--files-only", "--recursive", `${REMOTE}:${BUCKET}/${PREFIX}`]) || "[]") as
    Array<{ Path: string; Size: number; ModTime?: string }>;
  return rows.map((r) => {
    const t = r.ModTime ? Date.parse(r.ModTime) : NaN;
    return { key: PREFIX + r.Path, size: r.Size, mtimeMs: Number.isFinite(t) ? t : null };
  });
}

function fail(msg: string): never {
  console.error("error: " + msg);
  process.exit(2);
}

async function main(): Promise<void> {
  const path = arg("--owners");
  if (!path) fail("--owners <json> is required (the D1 owner snapshot)");
  if (!Number.isFinite(MAX_OBJECTS) || MAX_OBJECTS <= 0) fail("--max-objects must be a positive number");
  if (!Number.isFinite(GRACE_MS) || GRACE_MS < 0) fail("--grace-hours must be a number of hours, 0 or more");
  const owners = JSON.parse(readFileSync(path as string, "utf8")) as { renderRows?: RenderKeyRow[]; shotRows?: ShotKeyRow[]; projectNames?: string[] };
  if (!Array.isArray(owners.renderRows) || !Array.isArray(owners.shotRows)) fail("snapshot needs renderRows and shotRows arrays");

  console.log(`# R2 render-orphan GC -- ${APPLY ? "APPLY" : "DRY RUN"}`);
  const objects = listRenders();
  const refusal = refuseOversizedSweep(objects.length, MAX_OBJECTS);
  if (refusal) fail(refusal);
  const present = new Set(objects.map((o) => o.key));

  // A doc absent from the listing is absent; a doc present that cannot be read throws and aborts.
  const idx = await buildRenderOwnerIndex({
    renderRows: owners.renderRows as RenderKeyRow[],
    shotRows: owners.shotRows as ShotKeyRow[],
    projectNames: owners.projectNames,
    readDoc: async (key) => (present.has(key) ? JSON.parse(rclone(["cat", `${REMOTE}:${BUCKET}/${key}`])) : null),
  });
  const now = Date.now();
  const r = reconcileRenders(objects, idx, now, GRACE_MS);
  console.log(`owners: ${idx.liveJobIds.size} live job ids, ${idx.liveClipJobIds.size} live clip jobs, ${idx.referencedKeys.size} named keys, ${idx.docsRead} docs read`);
  console.log(`scanned ${objects.length}: ${r.orphanCount} orphan (${r.orphanBytes} bytes), ${r.kept.length} kept, ${r.outOfScope.length} out of scope\n`);
  for (const c of [...r.orphans].sort((a, b) => a.key.localeCompare(b.key))) console.log(`  DELETE ${c.key}  (${c.size} B)  [${c.reason}]`);

  if (!APPLY) {
    console.log("\nDRY RUN -- nothing deleted. Re-run with --apply to delete the orphan set above.");
    return;
  }
  let deleted = 0;
  // cf#1309: an owner marker comes last in r.orphans. Keep it if any sibling in its tree failed: without
  // it the sibling would read as legacy, out of scope, and the re-list check below would not see it.
  const failedClipJobs = new Set<string>();
  for (const c of r.orphans) {
    const marker = clipJobOwnerMarkerOf(c.key);
    if (marker && failedClipJobs.has(marker)) {
      console.log(`  KEPT ${c.key}: a sibling in this tree did not delete, so the marker stays and the next run finds it`);
      continue;
    }
    const seg = c.key.split("/")[1] ?? "";
    try {
      rclone(["deletefile", `${REMOTE}:${BUCKET}/${c.key}`]);
      deleted++;
      console.log(`  deleted ${c.key}`);
    } catch (e) {
      if (jobKindOf(seg) === "clips") failedClipJobs.add(seg);
      console.log(`  FAILED ${c.key}: ${(e as Error).message} (continuing)`);
    }
  }
  const survivors = reconcileRenders(listRenders(), idx, now, GRACE_MS).orphans;
  console.log(`\ndeleted ${deleted}/${r.orphanCount}; re-list verification: ${survivors.length} orphan(s) remain`);
  if (survivors.length) {
    for (const c of survivors) console.log(`  STILL PRESENT ${c.key}`);
    process.exit(1);
  }
  console.log("verified: orphan set is empty.");
}

main().catch((e) => fail((e as Error).message));
