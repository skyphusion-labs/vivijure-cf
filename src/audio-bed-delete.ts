// cf#1016: an uploaded audio bed can be deleted from the studio.
//
// POST /api/storyboard/audio-upload writes a bed to `audio/<uuid>.<ext>` and, until this file, nothing
// removed one: the only path was the operator going at storage directly. The render reclaim leaves
// beds alone on purpose (src/record-reclaim.ts, `audio_key`), because a bed is owned by its upload and
// any render may select it. So this is the bed's own delete, with three rules:
//
//   1. SCOPE. Only a key with the exact shape the upload route mints is accepted: `audio/`, a UUID, and
//      one of the upload extensions. Nothing else under `audio/` and nothing outside it can be named,
//      so this route cannot delete a render artifact, a cast file, or a generated score.
//   2. MISSING is a 404, so a second delete says so instead of reporting a deletion that did not happen.
//   3. IN USE is a 409. A film render that has not finished reads its bed at mux time, so deleting it
//      under a running film would fail that film late. The check reads the job doc of every film row
//      that is not terminal (a handful at most on a single-operator studio) and refuses if any names
//      this key. A finished render no longer needs the bed: its sound is already in the film.
import type { Env } from "./env";

/** The extensions POST /api/storyboard/audio-upload writes (AUDIO_UPLOAD_EXT values). */
export const AUDIO_BED_EXTENSIONS = ["mp3", "wav", "aac", "m4a", "ogg", "webm"] as const;

const BED_NAME_RE = new RegExp(
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(" + AUDIO_BED_EXTENSIONS.join("|") + ")$",
);

/** The bed's storage key for a route name, or null when the name is not one the upload route mints. */
export function uploadedBedKey(name: string): string | null {
  const n = String(name || "").trim().toLowerCase();
  return BED_NAME_RE.test(n) ? `audio/${n}` : null;
}

/** How many unfinished film rows the in-use check reads. A studio with more than this many renders in
 *  flight at once is refused rather than checked partly: a partial check that says "free" is wrong. */
export const IN_USE_SCAN_LIMIT = 200;

type BedEnv = Pick<Env, "R2_RENDERS" | "DB">;

export type BedDeleteResult =
  | { status: 200; body: { ok: true; key: string; deleted: true } }
  | { status: 400 | 404 | 409 | 503; body: { ok: false; error: string; key?: string; renders?: string[] } };

/** Film job ids of unfinished renders whose job doc selects `key` as its bed. */
export async function rendersUsingBed(env: BedEnv, key: string): Promise<{ jobIds: string[]; complete: boolean }> {
  const rows = await env.DB.prepare(
    `SELECT job_id FROM renders
      WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
        AND job_id LIKE 'film-%'
      ORDER BY id DESC
      LIMIT ?`,
  )
    .bind(IN_USE_SCAN_LIMIT + 1)
    .all<{ job_id: string }>();
  const list = (rows.results ?? []).map((r) => String(r.job_id));
  const complete = list.length <= IN_USE_SCAN_LIMIT;
  const jobIds: string[] = [];
  for (const id of list.slice(0, IN_USE_SCAN_LIMIT)) {
    const obj = await env.R2_RENDERS.get(`renders/${id}/film-job.json`);
    if (!obj) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(await obj.text());
    } catch {
      // An unreadable doc cannot prove the bed is free. Count it as a holder.
      jobIds.push(id);
      continue;
    }
    if (doc && typeof doc === "object" && (doc as { audio_key?: unknown }).audio_key === key) jobIds.push(id);
  }
  return { jobIds, complete };
}

/** Delete one uploaded bed. Pure of HTTP: the route maps the result to a response. */
export async function deleteUploadedBed(env: BedEnv, name: string): Promise<BedDeleteResult> {
  const key = uploadedBedKey(name);
  if (!key) {
    return {
      status: 400,
      body: { ok: false, error: "not an uploaded audio bed: expected audio/<uuid>.<" + AUDIO_BED_EXTENSIONS.join("|") + ">" },
    };
  }
  if (!(await env.R2_RENDERS.head(key))) return { status: 404, body: { ok: false, error: "audio bed not found", key } };
  const use = await rendersUsingBed(env, key);
  if (use.jobIds.length) {
    return {
      status: 409,
      body: { ok: false, error: "this audio bed is used by a render that has not finished; delete it after the render ends", key, renders: use.jobIds },
    };
  }
  if (!use.complete) {
    return { status: 503, body: { ok: false, error: "too many renders in flight to check this bed is free; try again later", key } };
  }
  await env.R2_RENDERS.delete(key);
  return { status: 200, body: { ok: true, key, deleted: true } };
}
