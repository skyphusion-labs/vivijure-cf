// Pure R2 RENDER-orphan reconciliation core (cf#1009, the second half of the #779 code ruling).
//
// No Worker globals. The IO is injected (`readDoc`), so this unit-tests under the tsc + vitest gate
// against real SQLite rows and an in-memory bucket (tests/r2-render-orphan-1009.test.ts). The live
// IO is scripts/r2-render-orphan-gc.ts, which lists the bucket with rclone and acts on the verdict.
//
// THE RULE IS THE CAST RECONCILER'S, generalised and not replaced (src/r2-orphan-reconcile.ts, the
// #298 near-miss): a key is an orphan only when NO live owner is found, and anything whose owner
// cannot be PROVEN from records is out of scope, never deleted. The cast core is untouched.
//
// WHAT IS IN SCOPE (lead ruling on #1009, 2026-11-06). Only trees whose owner is a record id:
//
//   renders/<film-id>/...        film-<uuid>, owned by a live renders.job_id, a live shot_records
//                                film_id, or a shard id a live scatter doc names (shard rows can be
//                                missing until a poll self-heals them).
//   renders/<scatter-id>/...     scatter-<uuid>, owned by a live renders.job_id.
//   renders/<clips-id>/...       clips-<uuid>, KEPT when a live film doc names it as clip_job_id, or
//                                when a live renders row has it as job_id (a standalone clip job,
//                                POST /api/render/clips, cf#1309). With no such owner it is an ORPHAN
//                                only if the tree holds the owner marker (record-reclaim.ts
//                                clipJobOwnerKey), which the standalone door writes before its row:
//                                the marker proves the tree was born with a row, so no row means the
//                                row is gone. A tree with no marker is a film's clip job or a
//                                standalone job from before cf#1309, and nothing proves either dead,
//                                so it stays OUT OF SCOPE. There is no age rule for it.
//   renders/logs/<job-id>.txt    the render log, owned by the same job id (render-log.js).
//
// WHAT IS OUT OF SCOPE, each deliberately:
//   renders/<project>/...        project-keyed trees. Two sanitisers write that segment and they
//                                disagree, and project names are mutable, so ownership would be a
//                                name match. That is the #298 near-miss class.
//   renders/cast/...             owned by cast delete and the cast reconciler; "cast" is not a job id,
//                                so the job-tree rule already leaves it alone.
//   bundles/, audio/, keyframe-stage/, module state docs, everything not under renders/
//                                named by no record; only an AGE rule could sweep them, and there is
//                                no ruling for one.
//
// THREE GUARDS ON TOP, each failing toward keep:
//   - any key a live record or a live job doc names is kept, whatever tree it is in;
//   - anything younger than the grace window, or with no readable mtime, is kept: a film doc is
//     written before its renders row exists;
//   - a job-shaped segment that equals a live project name (raw or either sanitised form) is out of
//     scope, so a project that happens to be named like a job id is never read as one.

import {
  clipJobDocKey,
  clipJobIdOf,
  clipJobOwnerKey,
  parseJobDocKeys,
  renderRowKeys,
  shotRowKeys,
  type RenderKeyRow,
  type ShotKeyRow,
} from "./record-reclaim.ts";

/** The D1 reads the owner index is built from. Exported so the test runs the SAME SQL the operator
 *  runs (`wrangler d1 execute ... --json`), not a hand-built row. */
export const RENDER_OWNER_SQL = "SELECT id, job_id, project, bundle_key, output_key, keyframes_json, output_json FROM renders";
export const SHOT_OWNER_SQL = "SELECT film_id, still_key, wav_key, clip_key FROM shot_records";
export const PROJECT_NAME_SQL = "SELECT name FROM storyboard_projects";

export const DEFAULT_GRACE_MS = 48 * 3600 * 1000;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const JOB_ID_RE = new RegExp(`^(film|scatter|clips)-${UUID}$`);
const LOG_KEY_RE = new RegExp(`^renders/logs/((?:film|scatter|clips)-${UUID})\\.txt$`);

export type JobKind = "film" | "scatter" | "clips";

/** The kind of a job-id-shaped path segment, or null. */
export function jobKindOf(seg: string): JobKind | null {
  const m = JOB_ID_RE.exec(seg);
  return m ? (m[1] as JobKind) : null;
}

/** The two sanitisers that write a project segment today, plus the raw name. */
export function projectSegmentForms(name: string): string[] {
  const forms = new Set<string>([name]);
  forms.add((name || "x").replace(/[^a-zA-Z0-9_-]/g, "_"));
  forms.add(name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "project");
  return [...forms];
}

export interface RenderObjectLite {
  key: string;
  size: number;
  /** Last-modified, epoch ms. Missing or unparseable reads as "too young to judge". */
  mtimeMs?: number | null;
}

export interface RenderOwnerInput {
  renderRows: RenderKeyRow[];
  shotRows: ShotKeyRow[];
  projectNames?: string[];
  /** Read one R2 JSON doc. Resolve null when the object does not exist; THROW on any other failure.
   *  A throw aborts the index: a live doc that cannot be read leaves its keys undetermined. */
  readDoc: (key: string) => Promise<unknown | null>;
}

export interface RenderOwnerIndex {
  liveJobIds: Set<string>;
  liveClipJobIds: Set<string>;
  referencedKeys: Set<string>;
  projectSegments: Set<string>;
  docsRead: number;
  /** Clip job ids whose tree holds the owner marker (cf#1309). Read from the LISTING, not from records,
   *  so `reconcileRenders` fills it; a caller of `classifyRenderKey` alone may pass it. Absent reads as
   *  "no tree is marked", which keeps every unowned clips tree out of scope. */
  markedClipJobIds?: Set<string>;
}

/** The clip job id whose owner marker this key is, or null. */
export function clipJobOwnerMarkerOf(key: string): string | null {
  const seg = key.split("/")[1] ?? "";
  return jobKindOf(seg) === "clips" && key === clipJobOwnerKey(seg) ? seg : null;
}

export async function buildRenderOwnerIndex(input: RenderOwnerInput): Promise<RenderOwnerIndex> {
  const liveJobIds = new Set<string>();
  const liveClipJobIds = new Set<string>();
  const referencedKeys = new Set<string>();
  const projectSegments = new Set<string>();
  let docsRead = 0;

  const projects = [...(input.projectNames ?? [])];
  for (const row of input.renderRows) {
    if (row.job_id) liveJobIds.add(row.job_id);
    if (row.project) projects.push(row.project);
    for (const k of renderRowKeys(row)) referencedKeys.add(k);
  }
  for (const k of shotRowKeys(input.shotRows)) referencedKeys.add(k);
  for (const s of input.shotRows) if (s.film_id) liveJobIds.add(s.film_id);
  for (const p of projects) if (p) for (const f of projectSegmentForms(p)) projectSegments.add(f);

  const harvest = (doc: unknown) => { for (const k of parseJobDocKeys(doc)) referencedKeys.add(k); };

  // Scatter parents first: their shard films are live even when the shard rows are missing.
  for (const id of [...liveJobIds]) {
    if (jobKindOf(id) !== "scatter") continue;
    const doc = await input.readDoc(`renders/${id}/scatter-job.json`);
    docsRead++;
    if (doc) harvest(doc);
    const shards = doc && typeof doc === "object" ? (doc as { shard_film_ids?: unknown }).shard_film_ids : undefined;
    if (Array.isArray(shards)) for (const s of shards) if (typeof s === "string" && s) liveJobIds.add(s);
  }
  // cf#1309: a standalone clip job's row is its owner, and its doc names its clips and takes.
  for (const id of [...liveJobIds]) {
    if (jobKindOf(id) !== "clips") continue;
    liveClipJobIds.add(id);
    const doc = await input.readDoc(clipJobDocKey(id));
    docsRead++;
    if (doc) harvest(doc);
  }
  for (const id of liveJobIds) {
    if (jobKindOf(id) !== "film") continue;
    const doc = await input.readDoc(`renders/${id}/film-job.json`);
    docsRead++;
    if (!doc) continue;
    harvest(doc);
    const clipId = clipJobIdOf(doc);
    if (!clipId) continue;
    liveClipJobIds.add(clipId);
    const clipDoc = await input.readDoc(clipJobDocKey(clipId));
    docsRead++;
    if (clipDoc) harvest(clipDoc);
  }
  return { liveJobIds, liveClipJobIds, referencedKeys, projectSegments, docsRead };
}

export type RenderDecision = "keep" | "orphan" | "out-of-scope";

/** cf#1009: a stable code per rule, so a report can count and sample by rule. `reason` carries ids and is
 *  for reading; `rule` never does. Every return in classifyRenderKey sets exactly one. */
export type RenderRule =
  | "not-renders"            // out of scope: outside renders/
  | "named"                  // keep: named by a live record or a live job doc
  | "no-mtime"               // keep: no readable mtime
  | "grace"                  // keep: inside the grace window
  | "log-live"               // keep: render log of a live job
  | "log-dead"               // orphan: render log of a job with no live owner
  | "not-job-tree"           // out of scope: project-keyed or unrecognised
  | "project-name"           // out of scope: job-shaped segment that is also a live project name
  | "clips-live"             // keep: clip job of a live film or a live clip job row
  | "clips-marked-dead"      // orphan: standalone clip job with an owner marker and no live row
  | "clips-unmarked"         // out of scope: clip job with no owner marker and no live owner
  | "job-live"               // keep: under a live film or scatter job
  | "job-dead";              // orphan: film or scatter job with no live owner

export interface RenderClassification {
  key: string;
  size: number;
  decision: RenderDecision;
  reason: string;
  rule: RenderRule;
}

export function classifyRenderKey(
  obj: RenderObjectLite,
  idx: RenderOwnerIndex,
  nowMs: number,
  graceMs: number = DEFAULT_GRACE_MS,
): RenderClassification {
  const { key, size } = obj;
  const mk = (decision: RenderDecision, rule: RenderRule, reason: string): RenderClassification => ({ key, size, decision, reason, rule });

  if (!key.startsWith("renders/")) return mk("out-of-scope", "not-renders", "not under renders/");
  if (idx.referencedKeys.has(key)) return mk("keep", "named", "named by a live record or a live job doc");
  const mtime = typeof obj.mtimeMs === "number" && Number.isFinite(obj.mtimeMs) ? obj.mtimeMs : null;
  if (mtime === null) return mk("keep", "no-mtime", "no readable mtime; too young to judge");
  if (nowMs - mtime < graceMs) return mk("keep", "grace", "inside the grace window; may be in flight");

  const log = LOG_KEY_RE.exec(key);
  if (log) {
    return idx.liveJobIds.has(log[1])
      ? mk("keep", "log-live", `render log of live job ${log[1]}`)
      : mk("orphan", "log-dead", `render log of job ${log[1]}, which has no live owner`);
  }

  const seg = key.split("/")[1] ?? "";
  const kind = jobKindOf(seg);
  if (!kind) return mk("out-of-scope", "not-job-tree", "not a job tree (project-keyed or unrecognised)");
  if (idx.projectSegments.has(seg)) return mk("out-of-scope", "project-name", `segment ${seg} is also a live project name`);
  if (kind === "clips") {
    if (idx.liveClipJobIds.has(seg)) return mk("keep", "clips-live", `clip job ${seg} of a live film or a live clip job row`);
    return idx.markedClipJobIds?.has(seg)
      ? mk("orphan", "clips-marked-dead", `standalone clip job ${seg} has an owner marker and no live renders row (cf#1309)`)
      : mk("out-of-scope", "clips-unmarked", `clip job ${seg} has no owner marker and no live owner; a film clip job or a standalone job from before cf#1309`);
  }
  return idx.liveJobIds.has(seg)
    ? mk("keep", "job-live", `under live ${kind} ${seg}`)
    : mk("orphan", "job-dead", `${kind} ${seg} has no live renders row, shot record or scatter parent`);
}

export interface RenderReconcileResult {
  orphans: RenderClassification[];
  kept: RenderClassification[];
  outOfScope: RenderClassification[];
  orphanBytes: number;
  orphanCount: number;
}

export function reconcileRenders(
  objects: RenderObjectLite[],
  idx: RenderOwnerIndex,
  nowMs: number,
  graceMs: number = DEFAULT_GRACE_MS,
): RenderReconcileResult {
  const orphans: RenderClassification[] = [];
  const kept: RenderClassification[] = [];
  const outOfScope: RenderClassification[] = [];
  const marked = new Set(idx.markedClipJobIds ?? []);
  for (const o of objects) {
    const id = clipJobOwnerMarkerOf(o.key);
    if (id) marked.add(id);
  }
  const withMarks: RenderOwnerIndex = { ...idx, markedClipJobIds: marked };
  for (const o of objects) {
    const c = classifyRenderKey(o, withMarks, nowMs, graceMs);
    (c.decision === "orphan" ? orphans : c.decision === "keep" ? kept : outOfScope).push(c);
  }
  // A marker goes LAST. It is what makes the rest of its tree an orphan, so deleting it first and then
  // failing on a sibling would leave that sibling reading as legacy: kept, and invisible to the re-list
  // check. The IO also skips a marker whose siblings did not all go (scripts/r2-render-orphan-gc.ts).
  orphans.sort((a, b) => Number(clipJobOwnerMarkerOf(a.key) !== null) - Number(clipJobOwnerMarkerOf(b.key) !== null));
  return { orphans, kept, outOfScope, orphanBytes: orphans.reduce((n, c) => n + (c.size || 0), 0), orphanCount: orphans.length };
}

/** Refuse up front, before anything is deleted, when the listing is bigger than the operator's cap. */
export function refuseOversizedSweep(count: number, cap: number): string | null {
  return count > cap
    ? `listing has ${count} objects, over the cap of ${cap}. Nothing was deleted. Raise --max-objects deliberately, or narrow the run.`
    : null;
}

// ---- cf#1009 dry-run summary: counts, bytes and sample keys per rule, for the GC's report ----

export interface RuleSummary {
  rule: RenderRule;
  decision: RenderDecision;
  count: number;
  bytes: number;
  /** Up to SAMPLE_PER_RULE keys, in key order, so two runs on one input agree. */
  sample: string[];
}

export const SAMPLE_PER_RULE = 10;

export interface DryRunReport {
  scanned: number;
  wouldDelete: { count: number; bytes: number };
  kept: number;
  outOfScope: number;
  rules: RuleSummary[];
  /** Every object the sweep would delete, with its reason. The summary itself deletes nothing. */
  wouldDeleteObjects: Array<{ key: string; size: number; rule: RenderRule; reason: string }>;
}

/** Pure. The dry-run report for one reconcile result. */
export function buildDryRunReport(r: RenderReconcileResult, sample: number = SAMPLE_PER_RULE): DryRunReport {
  const all = [...r.orphans, ...r.kept, ...r.outOfScope];
  const byRule = new Map<RenderRule, RenderClassification[]>();
  for (const c of all) {
    const list = byRule.get(c.rule) ?? [];
    list.push(c);
    byRule.set(c.rule, list);
  }
  const order: RenderDecision[] = ["orphan", "keep", "out-of-scope"];
  const rules = [...byRule.entries()]
    .map(([rule, list]) => ({
      rule,
      decision: list[0].decision,
      count: list.length,
      bytes: list.reduce((n, c) => n + (c.size || 0), 0),
      sample: list.map((c) => c.key).sort().slice(0, sample),
    }))
    .sort((a, b) => order.indexOf(a.decision) - order.indexOf(b.decision) || b.count - a.count || a.rule.localeCompare(b.rule));
  return {
    scanned: all.length,
    wouldDelete: { count: r.orphanCount, bytes: r.orphanBytes },
    kept: r.kept.length,
    outOfScope: r.outOfScope.length,
    rules,
    wouldDeleteObjects: [...r.orphans]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((c) => ({ key: c.key, size: c.size, rule: c.rule, reason: c.reason })),
  };
}
