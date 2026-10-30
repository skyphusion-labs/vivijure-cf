// Pure R2 reclaim core for a RECORD DELETE (cf#779, LG-2/LG-3).
//
// `docs/legal/PRIVACY.md` Section 7 promises that the studio's delete actions "remove the
// corresponding records and free their stored files". Cast delete has kept that promise since #298.
// Project delete and render delete did not: they removed the D1 row and left every R2 object behind,
// with nothing left that names the keys. Conrad ruled the CODE is corrected, not the promise (#779
// step 4, the code path: "delete R2 artifacts on project/render delete, gated by
// `countOtherRowsWithOutputKey`").
//
// No IO, no Worker globals: data in, decision out, so it unit-tests under the tsc + vitest gate.
// The live IO wrapper is `src/record-reclaim-io.ts`. Same split as `src/r2-orphan-reconcile.ts`,
// and the same doctrine, which is the load-bearing part:
//
//   A KEY IS DELETABLE ONLY WHEN NO OTHER LIVE RECORD REFERENCES IT.
//
// That is not defensive boilerplate here, it is the shape of the bucket. MEASURED by reading the key
// builders rather than assumed:
//
//   PER-RENDER, exclusively owned (film_id === renders.job_id; render-sweep.js:110 heads
//   `filmJobDocKey(jobId)` straight off the row's job id):
//     renders/<job_id>/film-job.json        film-model.js:114
//     renders/<job_id>/film.mp4             film-output-key.js:5
//     renders/<job_id>/film-ff<n>.mp4|.srt|.meta.json, film.srt, film-audio-<hex>.mp4,
//       partials/partial-<NNN>.mp4          film-orchestrator.js, video-finish-assemble.js
//     renders/<clip_job_id>/clips-job.json  render-orchestrator.js:44 (id lives IN the film doc)
//     renders/<scatter_id>/scatter-job.json scatter-orchestrator.js:22
//     renders/logs/<job_id>.txt             render-log.js:4  (NOT under renders/<job_id>/)
//
//   PER-PROJECT, SHARED ACROSS RENDERS BY DESIGN, deterministic on shot id, so two renders of one
//   project collide on one key ON PURPOSE. `assertProjectKey` (key-safety.js) ENFORCES that every
//   module-returned artifact is project-keyed, so this is the rule and not an edge case:
//     renders/<project>/clips/<shot>_<module>.mp4   render-orchestrator.js:18
//     renders/<project>/clips/<shot>_finished.mp4   written by a backend or module without core#379.
//       With it, a film's finish clips are under renders/<project>/clips/<film_id>/ (see renderClipPrefix),
//       and vivijure-backend#549 still writes <shot>_finished.latest.json, which nothing reads (see core#385).
//     renders/<project>/clips/<shot>_<suffix>.mp4   an append_suffix step (_up, _bl, _ls). Still shared.
//     renders/<project>/dialogue/<shot>.wav         film-orchestrator.js:202
//     renders/<project>/keyframes/<shot>.png        film-orchestrator.js:2866
//     renders/<project>/bundle-kf/<shot>.png        src/bundle-keyframes.ts:44
//     bundles/<projectName>-<hash>.tar.gz           bundle-assembler.js:161 (content-addressed, so
//                                                   an identical re-render SHARES one bundle)
//
// Two live mechanisms depend on that sharing and would break if a record delete swept the project
// prefix: `archiveExistingClipTakes` (render-orchestrator.js:17) copies a previous take aside before
// a reroll overwrites the clip key, and `listProjectKeyframes` (film-orchestrator.js:2863) ADOPTS an
// existing keyframe object across renders of the same project behind a provenance hash. The project
// name in that prefix is also MUTABLE and sanitized, so a prefix sweep can hit a renamed project's
// successor or a name-collided sibling. So the reassuring-looking fix, "delete renders/<project>/
// when the project goes", destroys a sibling render's only copy of its clips. Deleting an object
// another record still needs is a worse defect than the leak this closes, so the gate IS the
// feature, and the candidates come from records rather than from prefixes.
//
// WHAT IS DELIBERATELY NOT CLAIMED. Objects whose owning row was deleted BEFORE this change are
// unreachable from D1 and are NOT reclaimed here; they are the "plus a real orphan sweep" half of
// the #779 ruling, and `r2-orphan-reconcile.ts` covers only the cast trees today. Nothing in this
// file should be read as closing that.

/** A render row, narrowed to the columns that NAME R2 keys. */
export interface RenderKeyRow {
  id: number;
  job_id: string;
  project: string | null;
  bundle_key: string | null;
  output_key: string | null;
  /** JSON array of {shot_id,key} (renders.keyframes_json). */
  keyframes_json?: string | null;
  /** The finished-render payload (renders.output_json). */
  output_json?: string | null;
}

/** A shot_records row (migration 0022), narrowed to its three artifact keys. */
export interface ShotKeyRow {
  film_id: string;
  still_key: string | null;
  wav_key: string | null;
  clip_key: string | null;
}

/** Why a candidate key was kept rather than deleted. */
export interface RetainedKey {
  key: string;
  reason: string;
}

export interface ReclaimPlan {
  /** Keys to delete, de-duplicated, in a stable order. */
  deletable: string[];
  /** Candidates a live sibling still references. */
  retained: RetainedKey[];
}

/** The R2 prefix one render's job documents and assembled outputs live under. film_id === job_id. */
export function renderDocPrefix(jobId: string): string {
  return `renders/${jobId}/`;
}

/** The folder a render's finish clips live under (vivijure-core#379). Unlike the per-project keys above,
 *  nothing else writes here, so a render's own folder is safe to sweep. Its intermediate clips are named
 *  by no record, so a sweep is the only way they are freed. Null if the project is not known. */
export function renderClipPrefix(project: unknown, jobId: string): string | null {
  return typeof project === "string" && project.length > 0 ? `renders/${project}/clips/${jobId}/` : null;
}

/** The render log. Keyed off job_id but NOT under `renders/<job_id>/`, so a prefix sweep of the
 *  render's own tree misses it; render-log.js:3 notes the History UI re-derives it rather than
 *  storing it, which is exactly why nothing in D1 names it. */
export function renderLogKeyFor(jobId: string): string {
  return `renders/logs/${jobId}.txt`;
}

function pushKey(into: string[], v: unknown): void {
  if (typeof v === "string" && v.length > 0) into.push(v);
}

/** Parse a `[{shot_id,key}]` column. A malformed column yields NO keys rather than throwing: a
 *  delete must not be blocked by an unreadable legacy row, and a key we cannot read is a key we
 *  must not delete. */
export function parseKeyframeKeys(json: string | null | undefined): string[] {
  if (!json) return [];
  const out: string[] = [];
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    for (const r of arr) {
      if (r && typeof r === "object") pushKey(out, (r as { key?: unknown }).key);
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * Keys named INSIDE `renders.output_json`.
 *
 * ONLY the three fields the payload builders actually write as keys are read: `output_key` and
 * `sidecar_key` (render-output-payload.js filmDonePayload) and `clips[].key` (the
 * finish_unavailable clips degrade, #519). Every other string in that blob is left alone on
 * purpose. Harvesting anything that merely LOOKS like a key would make a string match stand in for
 * an ownership relationship, and the blob also carries module names, prompts and error text.
 */
export function parseOutputJsonKeys(json: string | null | undefined): string[] {
  if (!json) return [];
  const out: string[] = [];
  try {
    const doc: unknown = JSON.parse(json);
    if (!doc || typeof doc !== "object") return [];
    const d = doc as { output_key?: unknown; sidecar_key?: unknown; clips?: unknown };
    pushKey(out, d.output_key);
    pushKey(out, d.sidecar_key);
    if (Array.isArray(d.clips)) {
      for (const c of d.clips) {
        if (c && typeof c === "object") pushKey(out, (c as { key?: unknown }).key);
      }
    }
  } catch {
    return [];
  }
  return out;
}

/** The clips-job document id, which lives inside the FILM document (film-model.d.ts:146). Its own
 *  `renders/<clip_job_id>/` tree is not reachable from the render row, so without this the clips
 *  job doc and every archived take it names are stranded. */
export function clipJobIdOf(doc: unknown): string | null {
  if (!doc || typeof doc !== "object") return null;
  const v = (doc as { clip_job_id?: unknown }).clip_job_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Keys a film or clips job document names, by an EXPLICIT ALLOWLIST.
 *
 * THE EXCLUSIONS ARE THE POINT, because a job doc is not a list of the render's own property. The
 * fields deliberately NOT harvested, each because another record owns it:
 *
 *   voice_ref_key        a CAST member's kept voice clip (cast_members.voice_ref_key). Deleting a
 *                        render would otherwise destroy a cast member's reference clip.
 *   keyframe_key /       the project-keyed keyframe set, already named by renders.keyframes_json,
 *   last_keyframe_key    and sometimes a cast PORTRAIT passed straight through as the still.
 *                        One exception below: a still this job's own keyframe job wrote.
 *   audio_key            the operator-uploaded music bed under `audio/`, owned by the upload and
 *                        reused by any render that selects it.
 *
 * `takes[]` IS harvested: `archiveExistingClipTakes` records an archived take ONLY here, so a doc
 * deleted without reading it strands every take that render ever rolled. Take keys are unique per
 * archive pass (timestamped, and the archiver skips anything already matching `_take<digits>`), so
 * exactly one doc names each one.
 *
 * A JOB-SCOPED still (cf#1059) IS harvested from a film that drew or copied its own. A full film row
 * carries no keyframes_json, so nothing else names that still, and a delete would strand it. A
 * from-keyframes child (`derive_mode` set) names its parent's still, so it harvests none.
 */
export function parseJobDocKeys(doc: unknown): string[] {
  const out: string[] = [];
  if (!doc || typeof doc !== "object") return out;
  const d = doc as { film_key?: unknown; silent_film_key?: unknown; film_finish?: unknown; shots?: unknown };
  pushKey(out, d.film_key);
  pushKey(out, d.silent_film_key);
  const film = doc as { derive_mode?: unknown; keyframes?: unknown };
  if (!film.derive_mode && Array.isArray(film.keyframes)) {
    for (const k of film.keyframes) {
      const key = k && typeof k === "object" ? (k as { keyframe_key?: unknown }).keyframe_key : undefined;
      if (typeof key === "string" && /\/keyframes\/[^/]+\/[^/]+$/.test(key)) pushKey(out, key);
    }
  }
  if (d.film_finish && typeof d.film_finish === "object") {
    pushKey(out, (d.film_finish as { sidecar_key?: unknown }).sidecar_key);
  }
  if (Array.isArray(d.shots)) {
    for (const s of d.shots) {
      if (!s || typeof s !== "object") continue;
      const shot = s as { clip_key?: unknown; still_key?: unknown; wav_key?: unknown; takes?: unknown };
      pushKey(out, shot.clip_key);
      pushKey(out, shot.still_key);
      pushKey(out, shot.wav_key);
      if (Array.isArray(shot.takes)) {
        for (const t of shot.takes) {
          if (t && typeof t === "object") pushKey(out, (t as { key?: unknown }).key);
          else pushKey(out, t);
        }
      }
    }
  }
  return out;
}

/** Every key ONE render row names, from D1 alone. */
export function renderRowKeys(row: RenderKeyRow): string[] {
  const out: string[] = [];
  pushKey(out, row.bundle_key);
  pushKey(out, row.output_key);
  out.push(...parseKeyframeKeys(row.keyframes_json));
  out.push(...parseOutputJsonKeys(row.output_json));
  return out;
}

/** Every key one set of shot_records rows names. */
export function shotRowKeys(rows: ShotKeyRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    pushKey(out, r.still_key);
    pushKey(out, r.wav_key);
    pushKey(out, r.clip_key);
  }
  return out;
}

/**
 * The keys still needed by records that SURVIVE this delete.
 *
 * Mirrors `buildOwnerIndex` in r2-orphan-reconcile.ts: ownership is decided against live rows, never
 * against a name pattern. Feed it the surviving render rows, their shot_records, and any key a
 * surviving record names that D1 does not carry.
 */
export function buildLiveKeyIndex(input: {
  renderRows: RenderKeyRow[];
  shotRows?: ShotKeyRow[];
  extraKeys?: string[];
}): Set<string> {
  const idx = new Set<string>();
  for (const row of input.renderRows) for (const k of renderRowKeys(row)) idx.add(k);
  for (const k of shotRowKeys(input.shotRows ?? [])) idx.add(k);
  for (const k of input.extraKeys ?? []) if (k) idx.add(k);
  return idx;
}

/**
 * Decide which candidates may be deleted.
 *
 * De-duplicates, preserves first-seen order so a plan is reproducible, and records a reason for
 * every retention so the caller can report a partial reclaim honestly instead of as a success.
 */
export function planReclaim(candidates: string[], live: Set<string>): ReclaimPlan {
  const deletable: string[] = [];
  const retained: RetainedKey[] = [];
  const seen = new Set<string>();
  for (const key of candidates) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (live.has(key)) {
      retained.push({ key, reason: "referenced by a live record that survives this delete" });
      continue;
    }
    deletable.push(key);
  }
  return { deletable, retained };
}

/**
 * True when a cast member's `voice_ref_key` is that member's OWN object and may be freed with it.
 *
 * The column holds two different shapes and only one is exclusively owned:
 *
 *   cast/<id>/voice-ref.<ext>                       EXCLUSIVE. The upload path writes it under the
 *                                                   member's own tree (src/cast-voice-sample.ts:281).
 *   renders/cast/clips/voice-sample_<module>.mp4     SHARED BY EVERY CAST MEMBER. `startCastVoiceSample`
 *                                                   invokes the talking door with
 *                                                   `context.project = "cast"` and
 *                                                   `shot_id = "voice-sample"`
 *                                                   (src/cast-voice-sample.ts:149,163), and every
 *                                                   module derives its clip key from exactly those
 *                                                   two values. So the key is a CONSTANT across
 *                                                   members, and `keepCastVoiceSample` promotes that
 *                                                   same constant into each member's column
 *                                                   (src/cast-voice-sample.ts:201).
 *
 * Deleting the second shape with one cast member destroys the kept voice reference of every other
 * member that also kept a generated sample. So the generated shape is LEFT BEHIND on purpose: a
 * known, reported leak is better than silently deleting another record's only copy. Freeing it
 * safely needs the shared key fixed at the source, which is its own change.
 */
export function ownsVoiceRefKey(castId: number, key: string | null | undefined): boolean {
  if (!key) return false;
  return key.startsWith(`cast/${castId}/`);
}

/**
 * True for a stored value that is not a key in OUR bucket and must never be handed to `delete`.
 *
 * THE GUARD IS CORRECT INDEPENDENTLY OF WHERE IT CAME FROM, and it came from a seed that no longer
 * exists: `migrations/demo/0001_demo_seed.sql` seeded `portrait_key` and `output_key` with absolute
 * `https://assets.skyphusion.net/...` URLs, and that migration went with the public demo door
 * (pr1019). What survives is the reason to keep this: `artifactUrl` in `public/cast.js` and
 * `public/planner-history-row.js` still returns an absolute `http(s)://` value VERBATIM instead of
 * routing it through `/api/artifact/`, so an absolute value is a shape these columns can legitimately
 * carry and any writer can still put one there. A delete of such a value is a harmless no-op, but it
 * would be counted as a freed object and reported as one, which is a lie in the reassuring
 * direction.
 */
export function isForeignRef(key: string): boolean {
  return /^https?:\/\//i.test(key);
}
