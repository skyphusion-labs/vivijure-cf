// cf#1206: DELETE /api/film/:id removes a film built as parts, as a whole.
//
// A part cannot be deleted on its own (DELETE /api/storyboard/renders/:id answers 409), because a
// later join, retake or retry needs it. So a long film's parts, joined versions and captions stayed in
// storage for good and counted against the quota.
//
// THE ORDER, and why:
//   1. Refuse while anything is in flight: a part running or submitting, a join out, or a new still
//      being drawn. Deleting under a live job leaves the job writing into keys nobody owns.
//   2. A film that could still act is STOPPED first, by a guarded write on the doc's etag. The cron
//      claims a part with the same guarded write, so exactly one of the two wins: either the stop
//      lands and the cron's claim fails, or the claim lands and this answers 409. Nothing can start
//      between the check and the delete.
//   3. Each part's renders go through the SAME reclaim the render route uses, one part at a time.
//      The other parts are still rows while a part goes, so a key two parts share is kept and then
//      freed with the last part that names it. One part at a time also keeps each pass inside the
//      reclaim's request budget, which a 64-part film in one pass would not.
//   4. Then the film's own tree, `renders/<film id>/` (every film-v*.mp4 and .srt), through the same
//      gate, so an object a surviving render names stays.
//   5. The list row, the cron marker, and the doc LAST, so a delete that fails part way can be run
//      again and picks up where it stopped. A finished part's rows are already gone, and its stored
//      child ids reclaim an empty tree.

import { loadParent, saveParent, clearActiveMarker, deleteParentRecords } from "./film-parent-store";
import { parentCanAct, type ParentDoc } from "./film-parent";
import {
  reclaimRenderRows,
  deleteShotRecords,
  deleteRenderRows,
  renderKeyRowsByProjects,
  type ReclaimReport,
} from "./record-reclaim-io";
import type { RenderKeyRow } from "./record-reclaim";
import type { StudioEnv } from "./orchestrator-env";

export type FilmDeleteResult =
  | { kind: "deleted"; objects_freed: number; objects_retained: number; renders_removed: number }
  | { kind: "not_found" }
  | { kind: "busy"; error: string }
  | { kind: "changed" }
  | { kind: "incomplete"; report: ReclaimReport };

/** Why this film cannot be deleted now, or null. */
export function filmDeleteBlocker(doc: ParentDoc): string | null {
  if (doc.parts.some((p) => p.status === "running" || p.status === "submitting")) {
    return "This film is still rendering. Wait until it stops, then delete it.";
  }
  if (doc.join_job_id) return "This film is being put together. Wait until that ends, then delete it.";
  if (doc.parts.some((p) => p.retake?.still_film_id)) return "A new picture is being drawn for this film. Wait until it ends, then delete it.";
  return null;
}

/** A child film whose renders row is missing still has its own tree. A synthetic row lets the same
 *  reclaim find it. Negative ids name no real row, so the survivor gate never excludes a real one. */
function synthetic(jobId: string, project: string, outputKey: string | null, id: number): RenderKeyRow {
  return { id, job_id: jobId, project, bundle_key: null, output_key: outputKey, keyframes_json: null, output_json: null };
}

export async function deleteParentFilm(env: StudioEnv, id: string): Promise<FilmDeleteResult> {
  const loaded = await loadParent(env, id);
  if (!loaded) return { kind: "not_found" };
  const blocker = filmDeleteBlocker(loaded.doc);
  if (blocker) return { kind: "busy", error: blocker };
  if (parentCanAct(loaded.doc)) {
    loaded.doc.phase = "stopped";
    loaded.doc.stop_reason = "deleting";
    if (!(await saveParent(env, loaded))) return { kind: "changed" };
  }
  await clearActiveMarker(env, id);
  const doc = loaded.doc;

  const freed = new Set<string>();
  const kept = new Set<string>();
  let removed = 0;
  let nextSynthetic = -1;
  const pass = async (rows: RenderKeyRow[]): Promise<ReclaimReport | null> => {
    if (!rows.length) return null;
    const report = await reclaimRenderRows(env, rows);
    for (const k of report.retained) kept.add(k.key);
    for (const k of report.deleted) freed.add(k);
    if (!report.complete) return report;
    await deleteShotRecords(env, rows.map((r) => r.job_id));
    const real = rows.filter((r) => r.id > 0).map((r) => r.id);
    if (real.length) await deleteRenderRows(env, real);
    removed += real.length;
    return null;
  };

  for (const part of doc.parts) {
    const rows = await renderKeyRowsByProjects(env, [part.project]);
    const known = new Set(rows.map((r) => r.job_id));
    for (const child of [part.child_film_id, part.retake?.from_film_id, part.retake?.still_film_id]) {
      if (child && !known.has(child)) {
        rows.push(synthetic(child, part.project, null, nextSynthetic--));
        known.add(child);
      }
    }
    const refused = await pass(rows);
    if (refused) return { kind: "incomplete", report: refused };
  }
  const own = await pass([synthetic(doc.film_id, doc.project, doc.output_key, nextSynthetic--)]);
  if (own) return { kind: "incomplete", report: own };

  await deleteParentRecords(env, doc);
  for (const k of freed) kept.delete(k);
  return { kind: "deleted", objects_freed: freed.size, objects_retained: kept.size, renders_removed: removed };
}
