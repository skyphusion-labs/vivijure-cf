// Live R2 + D1 reclaim for a record delete (cf#779, LG-2/LG-3). The decisions live in
// `src/record-reclaim.ts`; this file is the IO that feeds them and acts on the verdict.
//
// THE ORDERING DECISION, and it is the whole safety property, so read it before rearranging.
//
//   R2 IS RECLAIMED FIRST. THE D1 ROW IS DELETED LAST, AND ONLY ON A COMPLETE RECLAIM.
//
// The D1 row is the ONLY index of a render's keys. Nothing else can name them:
// `r2-orphan-reconcile.ts` classifies every key that is not a `cast/<id>/` tree or a cast-scheme
// `loras/<dir>/` as `out-of-scope` and never deletes it, BY DESIGN, so a render object orphaned by a
// row delete is unreachable by the existing sweep forever.
//
// So the two orderings fail very differently:
//
//   D1 first  -- a mid-delete failure leaves objects with nothing naming them. Invisible, permanent,
//                and exactly what the Section 7 promise cannot survive.
//   R2 first  -- a mid-delete failure leaves the ROW, still naming every key. Visible, and the retry
//                CONVERGES, because the keys already freed are simply absent from the next listing.
//
// The second is strictly recoverable, so the second is what this does. On an incomplete reclaim the
// row is KEPT and the caller answers 409; it does not report a success it did not achieve.
//
// NOTE THE ASYMMETRY WITH CAST DELETE, which is deliberate and not an inconsistency to tidy up.
// `hDeleteCast` deletes the row first and reclaims after (#298). That is safe THERE and only there,
// because the cast reconciler CAN find a `cast/<id>/` orphan with no live row. Renders and projects
// have no such backstop, which is why they get the opposite order.

import { countOtherRowsWithOutputKey } from "@skyphusion-labs/vivijure-core/renders-db";

import type { StudioEnv } from "./orchestrator-env";
import {
  buildLiveKeyIndex,
  clipJobIdOf,
  isForeignRef,
  parseJobDocKeys,
  planReclaim,
  renderDocPrefix,
  renderClipPrefix,
  renderLogKeyFor,
  renderRowKeys,
  shotRowKeys,
  type RenderKeyRow,
  type RetainedKey,
  type ShotKeyRow,
} from "./record-reclaim";

/**
 * Platform calls one record delete may issue before it stops short and refuses.
 *
 * WHAT THE NUMBER MEANS, because a bare constant invites someone to raise it: a Workers request may
 * make 1000 subrequests and EVERY R2 call and EVERY D1 call is one. 700 leaves the route its own
 * headroom. It is not a throughput knob; past it the invocation is KILLED mid-delete by the
 * platform, which is the condition this budget exists to convert into a loud refusal. Raising it
 * does not buy a bigger reclaim, it buys a delete that dies later.
 */
export const RECLAIM_SUBREQUEST_BUDGET = 700;

export interface ReclaimReport {
  /** True only when every candidate key was resolved: freed, or provably still needed. */
  complete: boolean;
  deleted: string[];
  retained: RetainedKey[];
  /** Keys a delete call rejected. A non-empty list forces `complete: false`. */
  failed: { key: string; error: string }[];
  /** Candidates not reached, because the subrequest budget ran out or a listing was truncated. */
  unreached: number;
  /** Platform calls spent. */
  spent: number;
}

interface Budget {
  spent: number;
  readonly cap: number;
}

const newBudget = (cap: number): Budget => ({ spent: 0, cap });

/** Charge one platform call. False when the budget is exhausted. */
function charge(b: Budget): boolean {
  if (b.spent >= b.cap) return false;
  b.spent += 1;
  return true;
}

/**
 * Every object under a prefix, following the cursor.
 *
 * R2 `list` returns ONE page; a render with many shots, and any project with history, has more than
 * one. `truncated` is the authority on whether another page exists, never the length of `objects`.
 * `exhausted` is RETURNED rather than thrown so the caller can keep the row instead of deleting it
 * against a listing it knows is partial: a truncated listing that reads as a complete one is how a
 * sweep deletes the first page and calls it done.
 */
export async function listAllKeys(
  env: StudioEnv,
  prefix: string,
  budget: Budget,
): Promise<{ keys: string[]; exhausted: boolean }> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    if (!charge(budget)) return { keys, exhausted: true };
    const page = await env.R2_RENDERS.list({ prefix, cursor });
    for (const obj of page.objects) keys.push(obj.key);
    // TRUNCATED WITH NO CURSOR IS AN EXHAUSTED READ, NOT A FINISHED ONE. The earlier form was
    // `cursor = page.truncated ? page.cursor : undefined`, which exits the loop on that shape and
    // returns `exhausted: false`: a listing that SAYS there is more, read as complete, which is the
    // precise failure the comment above warns about and the one that would have deleted a first
    // page and called the record clean. Found by the mutation harness, which could not produce a
    // red world for the partial-read refusal until this shape was reachable.
    if (page.truncated && !page.cursor) return { keys, exhausted: true };
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { keys, exhausted: false };
}

/** Read one JSON job document. Absent or unparseable yields null: a doc we cannot read is a doc
 *  whose keys we must not guess at. */
async function readJobDoc(env: StudioEnv, key: string, budget: Budget): Promise<unknown | null> {
  if (!charge(budget)) return null;
  try {
    const obj = await env.R2_RENDERS.get(key);
    if (!obj) return null;
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

async function shotRowsFor(env: StudioEnv, filmId: string, budget: Budget): Promise<ShotKeyRow[]> {
  if (!charge(budget)) return [];
  const rs = await env.DB.prepare(
    `SELECT film_id, still_key, wav_key, clip_key FROM shot_records WHERE film_id = ?1`,
  ).bind(filmId).all<ShotKeyRow>();
  return rs.results ?? [];
}

/** Surviving render rows: every render EXCEPT the ids being deleted. These are the records whose
 *  references make a candidate undeletable. */
async function survivingRenderRows(
  env: StudioEnv,
  doomedIds: number[],
  budget: Budget,
): Promise<RenderKeyRow[]> {
  if (!charge(budget)) return [];
  const holes = doomedIds.map((_, i) => `?${i + 1}`).join(",");
  const sql =
    `SELECT id, job_id, project, bundle_key, output_key, keyframes_json, output_json FROM renders` +
    (doomedIds.length ? ` WHERE id NOT IN (${holes})` : "");
  const rs = await env.DB.prepare(sql).bind(...doomedIds).all<RenderKeyRow>();
  return rs.results ?? [];
}

/** The shot_records of every surviving render, so a project-prefixed clip a sibling still owns is
 *  retained. Keyed on the survivors' film ids (film_id === job_id). */
async function survivingShotRows(
  env: StudioEnv,
  survivors: RenderKeyRow[],
  budget: Budget,
): Promise<{ rows: ShotKeyRow[]; exhausted: boolean }> {
  const rows: ShotKeyRow[] = [];
  const ids = survivors.map((r) => r.job_id).filter((s): s is string => !!s);
  // Chunked so a studio with a long render history does not build a statement D1 refuses.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (!charge(budget)) return { rows, exhausted: true };
    const holes = chunk.map((_, n) => `?${n + 1}`).join(",");
    const rs = await env.DB.prepare(
      `SELECT film_id, still_key, wav_key, clip_key FROM shot_records WHERE film_id IN (${holes})`,
    ).bind(...chunk).all<ShotKeyRow>();
    rows.push(...(rs.results ?? []));
  }
  return { rows, exhausted: false };
}

/**
 * The `countOtherRowsWithOutputKey` gate the #779 ruling names, applied where it is CORRECT.
 *
 * Core wrote that helper for exactly this job: the GPU handler writes `renders/<project>/<name>.mp4`,
 * so a re-render of one project at the same name overwrites and two render rows legitimately carry
 * one `output_key`. It is the core-owned statement of that rule, so it is the authority on this one
 * key rather than a second opinion derived here. It had NO caller before this change.
 *
 * IT IS ONLY CORRECT FOR A SINGLE-ROW DELETE, and that bound is the point. The helper counts rows
 * with `id != ?`, which in a PROJECT CASCADE includes the project's OTHER DOOMED rows. Trusting it
 * there would retain a key whose every owner is being deleted in the same operation: a leak wearing
 * the costume of a safety check. For a cascade the surviving-row index answers the same question
 * correctly, because it is built from the survivors only.
 */
async function outputKeyGate(env: StudioEnv, rows: RenderKeyRow[], budget: Budget): Promise<string[]> {
  if (rows.length !== 1) return [];
  const key = rows[0].output_key;
  if (!key || isForeignRef(key)) return [];
  if (!charge(budget)) return [key]; // Unmeasured means RETAIN: never delete on an unrun check.
  return (await countOtherRowsWithOutputKey(env, rows[0].id, key)) > 0 ? [key] : [];
}

/**
 * Derived sidecars that hang off an artifact key by SUFFIX and are named in no record at all:
 * `<key>.prov` (clip-provenance.js:18), `<finish step out>.hash` (film-orchestrator.js:1046),
 * `<sheet>.frames-meta.json` (src/render-frames.ts:99), `<audio>.beats.json`
 * (src/film-join-gate.ts:15).
 *
 * Listing on the FULL artifact key as a prefix finds them all, including shapes not enumerated
 * above, without guessing a suffix list that will go stale. It is only ever run on a key already
 * decided DELETABLE, so a sidecar of a retained artifact is never even looked at: correct by
 * construction rather than by a second gate.
 */
async function sidecarsOf(
  env: StudioEnv,
  artifactKey: string,
  budget: Budget,
): Promise<{ keys: string[]; exhausted: boolean }> {
  const listed = await listAllKeys(env, artifactKey, budget);
  return { keys: listed.keys.filter((k) => k !== artifactKey), exhausted: listed.exhausted };
}

/** Delete the planned keys through the METERED binding, so the storage ledger (migration 0013) is
 *  kept current by the same wrapper that accounts the writes. A raw bucket handle here would leave a
 *  ledger row per freed object and make usage read permanently HIGH. */
async function deleteKeys(
  env: StudioEnv,
  keys: string[],
  budget: Budget,
): Promise<{ deleted: string[]; failed: { key: string; error: string }[]; unreached: number }> {
  const deleted: string[] = [];
  const failed: { key: string; error: string }[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (!charge(budget)) return { deleted, failed, unreached: keys.length - i };
    try {
      await env.R2_RENDERS.delete(keys[i]);
      deleted.push(keys[i]);
    } catch (e) {
      failed.push({ key: keys[i], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { deleted, failed, unreached: 0 };
}

const emptyReport = (): ReclaimReport => ({
  complete: true, deleted: [], retained: [], failed: [], unreached: 0, spent: 0,
});

/**
 * Free the R2 objects owned by a set of render rows, retaining anything a surviving record needs.
 *
 * `rows` is every render being deleted in THIS operation: one for a render delete, all of a
 * project's renders for a project delete. Passing them together is what makes a project cascade
 * correct, because two renders of one project legitimately share keys and each must not be treated
 * as a live reference blocking the other.
 */
export async function reclaimRenderRows(
  env: StudioEnv,
  rows: RenderKeyRow[],
  opts?: { budget?: number },
): Promise<ReclaimReport> {
  if (rows.length === 0) return emptyReport();
  const budget = newBudget(opts?.budget ?? RECLAIM_SUBREQUEST_BUDGET);
  const doomedIds = rows.map((r) => r.id);
  const candidates: string[] = [];
  let partialRead = false;

  // 1. CANDIDATES, from the records themselves: the row's own columns, its job documents (including
  //    the clips job doc, whose id is only inside the film doc), its shot_records, its own R2 tree,
  //    and the render log that nothing in D1 names.
  for (const row of rows) {
    candidates.push(...renderRowKeys(row));
    candidates.push(renderLogKeyFor(row.job_id));

    const filmDoc = await readJobDoc(env, `${renderDocPrefix(row.job_id)}film-job.json`, budget);
    candidates.push(...parseJobDocKeys(filmDoc));

    const clipJobId = clipJobIdOf(filmDoc);
    if (clipJobId) {
      const clipDocKey = `${renderDocPrefix(clipJobId)}clips-job.json`;
      candidates.push(...parseJobDocKeys(await readJobDoc(env, clipDocKey, budget)));
      const clipTree = await listAllKeys(env, renderDocPrefix(clipJobId), budget);
      candidates.push(...clipTree.keys);
      if (clipTree.exhausted) partialRead = true;
    }

    candidates.push(...shotRowKeys(await shotRowsFor(env, row.job_id, budget)));

    const ownTree = await listAllKeys(env, renderDocPrefix(row.job_id), budget);
    candidates.push(...ownTree.keys);
    if (ownTree.exhausted) partialRead = true;

    // The doc's project is the one the keys were built from. A row's project can be renamed later.
    const clipPrefix = renderClipPrefix((filmDoc as { project?: unknown } | null)?.project ?? row.project, row.job_id);
    if (clipPrefix) {
      const clipFolder = await listAllKeys(env, clipPrefix, budget);
      candidates.push(...clipFolder.keys);
      if (clipFolder.exhausted) partialRead = true;
    }
  }

  // 2. THE GATE: keys the survivors still reference.
  const survivors = await survivingRenderRows(env, doomedIds, budget);
  const survivorShots = await survivingShotRows(env, survivors, budget);
  if (survivorShots.exhausted) partialRead = true;
  const live = buildLiveKeyIndex({
    renderRows: survivors,
    shotRows: survivorShots.rows,
    extraKeys: await outputKeyGate(env, rows, budget),
  });

  // A retained artifact keeps its sidecars. A folder sweep lists them as candidates in their own right,
  // and a clip whose `.hash` went would no longer pass the #583 gate, so it would re-run for nothing.
  for (const key of candidates) {
    const artifact = key.replace(/\.(hash|prov)$/, "");
    if (artifact !== key && live.has(artifact)) live.add(key);
  }

  // A stored absolute URL is not a key in this bucket; see isForeignRef for the shape and why. Drop it
  // before planning so it is never counted as a freed object.
  const plan = planReclaim(candidates.filter((k) => !isForeignRef(k)), live);

  // 3. SIDECARS of the keys that are actually going.
  const sidecars: string[] = [];
  for (const key of plan.deletable) {
    const found = await sidecarsOf(env, key, budget);
    sidecars.push(...found.keys);
    if (found.exhausted) partialRead = true;
  }
  const withSidecars = planReclaim([...plan.deletable, ...sidecars], live);

  // CARRY THE FIRST PASS'S RETENTIONS FORWARD. The second `planReclaim` is fed only keys the first
  // pass already cleared, so its own `retained` is empty BY CONSTRUCTION. Returning it alone
  // reported `retained: 0` on a reclaim that had correctly held back a sibling's keyframes, its
  // clips and a shared bundle: the deletes were right and the report was a lie in the reassuring
  // direction, which is the one nobody checks. Found by the sibling-gate and shared-output_key
  // cases in tests/record-delete-r2-reclaim-779.test.ts, which assert the REPORT and not only the
  // bucket for exactly this reason.
  const retained = [...plan.retained, ...withSidecars.retained];

  // A partial view of EITHER side is a reason to refuse, not to proceed: an under-read CANDIDATE set
  // under-deletes (a leak), and an under-read LIVE set over-deletes (a sibling loses its only copy).
  // The second cannot be undone, so neither is treated as good enough and nothing is deleted.
  if (partialRead) {
    return {
      complete: false,
      deleted: [],
      retained,
      failed: [],
      unreached: withSidecars.deletable.length,
      spent: budget.spent,
    };
  }

  const { deleted, failed, unreached } = await deleteKeys(env, withSidecars.deletable, budget);
  return {
    complete: failed.length === 0 && unreached === 0,
    deleted,
    retained,
    failed,
    unreached,
    spent: budget.spent,
  };
}

/** Drop the shot_records rows of the given film ids. D1 bookkeeping, run only after the bytes are
 *  gone, for the same reason the render row is: these rows NAME keys. */
export async function deleteShotRecords(env: StudioEnv, filmIds: string[]): Promise<void> {
  for (let i = 0; i < filmIds.length; i += 50) {
    const chunk = filmIds.slice(i, i + 50);
    const holes = chunk.map((_, n) => `?${n + 1}`).join(",");
    await env.DB.prepare(`DELETE FROM shot_records WHERE film_id IN (${holes})`).bind(...chunk).run();
  }
}

/** Render rows by internal id, narrowed to their key columns. */
export async function renderKeyRowsByIds(env: StudioEnv, ids: number[]): Promise<RenderKeyRow[]> {
  if (ids.length === 0) return [];
  const holes = ids.map((_, n) => `?${n + 1}`).join(",");
  const rs = await env.DB.prepare(
    `SELECT id, job_id, project, bundle_key, output_key, keyframes_json, output_json
       FROM renders WHERE id IN (${holes})`,
  ).bind(...ids).all<RenderKeyRow>();
  return rs.results ?? [];
}

/** Every render row belonging to a project, narrowed to its key columns. */
export async function projectRenderRows(env: StudioEnv, projectId: number): Promise<RenderKeyRow[]> {
  const rs = await env.DB.prepare(
    `SELECT id, job_id, project, bundle_key, output_key, keyframes_json, output_json
       FROM renders WHERE project_id = ?1`,
  ).bind(projectId).all<RenderKeyRow>();
  return rs.results ?? [];
}

/** Drop render rows by id, after their bytes are reclaimed. */
export async function deleteRenderRows(env: StudioEnv, ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const holes = chunk.map((_, n) => `?${n + 1}`).join(",");
    await env.DB.prepare(`DELETE FROM renders WHERE id IN (${holes})`).bind(...chunk).run();
  }
}
