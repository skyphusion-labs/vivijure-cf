// A long film built as parts: ordinary film jobs under one parent, joined at the end.
//
// A part is an ordinary film job in its own project. The parent never renders. It decides what to submit
// next, reads each part, and joins the finished films with POST /async/join-films. So a part takes the
// same path every other film takes, and this file holds only order, limits and state.
//
// The parent is a JSON document in R2, written with an etag match. Two ticks can run at once: a poll and
// the cron. A submit spends money, so a tick writes a claim on the part first, and only the tick whose
// claim landed submits. A crash between the submit and the next write leaves a stale claim. The next
// tick looks for a film in that part's own project since the claim, and adopts it. It never submits again by
// itself, because a second submit can buy the part twice.

export const MAX_SCENES_PER_PART = 40; // The largest film run so far has 20 shots. 40 is a limit, not a proof.
export const MAX_PARTS = 64; // MAX_JOIN_FILMS in containers/video-finish/app.py.
export const MAX_PARTS_IN_FLIGHT = 3;
export const MAX_JOIN_ATTEMPTS = 3;
// Longer than any Worker invocation can run, so a claim this old has no live owner.
export const STALE_CLAIM_MS = 15 * 60_000;
export const JOIN_MISSING_STREAK = 3;
/** How long a part waits after the door could not run its checks. Each ask costs a daily ceiling count. */
export const NOT_STARTED_BACKOFF_MS = 5 * 60_000;
// As long as the join's presigned URLs last.
export const JOIN_TIMEOUT_MS = 6 * 60 * 60_000;
export const ONE_UPLOAD_BYTES = 5_363_466_240; // MAX_FILM_BYTES in containers/video-finish/app.py.
const HOLD_AFTER_FIRST = "the first part is ready: watch it, then resume";
export const FILM_PARENT_PREFIX = "film-parents/";
export const FILM_PARENT_ACTIVE_PREFIX = "film-parents/active/";
export const FILM_PARENT_LIST_PREFIX = "film-parents/by-time/";
export const FILM_LIST_LIMIT = 50;

export type ParentPhase = "planned" | "running" | "stopped" | "join" | "done" | "failed";
export type PartStatus = "pending" | "submitting" | "running" | "done" | "failed";

/** A scene as the storyboard validator takes it (id, target_seconds), or with the names a film submit uses. */
export interface ParentScene {
  id?: string;
  shot_id?: string;
  prompt?: string;
  target_seconds?: number;
  seconds?: number;
  [key: string]: unknown;
}

export const sceneId = (s: ParentScene): string | undefined => s.shot_id ?? s.id;
export const sceneSeconds = (s: ParentScene): number | undefined => s.seconds ?? s.target_seconds;

export interface ParentLine {
  shot_id: string;
  text: string;
  voice_id?: string;
}

export interface ParentShared {
  motion_backend: string;
  style: "photoreal" | "anime";
  keyframe_backend?: string;
  keyframe_config?: Record<string, unknown>;
  motion_config?: Record<string, unknown>;
  finish_config?: Record<string, unknown>;
  film_finish_config?: Record<string, unknown>;
  cast_loras?: Record<string, string>;
  film_titles?: { title?: unknown; credits?: unknown };
  delivery_width: number;
  delivery_height: number;
  qualityTier?: string;
}

export interface PartOverride {
  index: number;
  cast_loras?: Record<string, string>;
  character_refs?: Record<string, unknown>;
  motion_backend?: string;
}

export interface ParentPart {
  part_id: string;
  index: number;
  project: string;
  shot_from: number;
  shot_to: number;
  status: PartStatus;
  phase: string | null;
  shots_done: number;
  shots_total: number;
  cost_est: number;
  error: string | null;
  /** Submits made. */
  attempts: number;
  /** Retries of this part that the ceiling does not count, because the run before them failed before its clips. */
  free_retries?: number;
  /** The part failed with no clip job on its film. Its stills are kept, and the retry's own estimate covers them. */
  failed_before_clips?: boolean;
  /** Moves only on a deliberate retry, so a repeat of the same request carries the same key. */
  generation: number;
  claimed_at: number | null;
  child_film_id: string | null;
  bundle_key: string | null;
  output_key: string | null;
  sidecar_key: string | null;
  /** A retake waiting to run, against the finished film it replaces. */
  retake: PartRetake | null;
  /** Do not ask the door again before this time. */
  not_before: number | null;
  /** Estimate of every retake so far, on top of cost_est x attempts. */
  retake_est: number;
  retakes: number;
}

/** Local shot ids, because a part is its own film. */
export interface PartRetake {
  from_film_id: string;
  shots: string[];
  prompts: Record<string, string>;
  lines: Record<string, { text: string; voice_id?: string }>;
  /** Shots that need a new still before their clip. Absent on a retake that keeps its stills. */
  still_shots?: string[];
  /** The seed for those stills. The backend re-uses a still by config hash, so a new one needs a new seed. */
  still_seed?: number;
  /** The film job drawing them. It is not the part's film: it has stills and no clips. */
  still_film_id?: string | null;
  /** Finished new stills, by local shot id. */
  stills?: Record<string, string>;
  /** Master board values before this retake, by master shot id, so a cancel can put them back. A null line
   *  means the shot had none. */
  undo: { prompts: Record<string, unknown>; lines: Record<string, ParentLine | null> };
}

export interface ParentDoc {
  version: 1;
  film_id: string;
  project: string;
  phase: ParentPhase;
  stop_reason: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  spend_ceiling_usd: number;
  cost_usd_per_shot_est: number;
  shared: ParentShared;
  storyboard: Record<string, unknown> & { scenes: ParentScene[] };
  character_refs: Record<string, unknown>;
  dialogue_lines: ParentLine[];
  overrides: PartOverride[];
  parts: ParentPart[];
  join_job_id: string | null;
  join_attempts: number;
  /** Starts at 1. A re-join writes a new key, so the film already delivered stays readable. */
  join_version: number;
  /** A part's film changed since the last finished join, so the delivered film is out of date. */
  rejoin_needed: boolean;
  join_missing: number;
  join_started_at: number | null;
  pause_after_first_part: boolean;
  first_part_released: boolean;
  request_hash: string;
  output_key: string | null;
  sidecar_key: string | null;
  bytes: number | null;
  duration_seconds: number | null;
  degraded: string | null;
  error: string | null;
}

export interface CreateParentBody {
  project?: unknown;
  idempotency_key?: unknown;
  storyboard?: unknown;
  character_refs?: unknown;
  dialogue_lines?: unknown;
  part_size?: unknown;
  breaks?: unknown;
  shared?: unknown;
  part_overrides?: unknown;
  spend_ceiling_usd?: unknown;
  cost_usd_per_shot_est?: unknown;
  pause_after_first_part?: unknown;
}

export class ParentRefusal extends Error {}

function refuse(message: string): never {
  throw new ParentRefusal(message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A doc written before a field existed must not read it as undefined: the ceiling is a sum of these, and a
 *  NaN never crosses anything. */
export function normalizeParentDoc(doc: ParentDoc): ParentDoc {
  doc.join_version ??= 1;
  doc.rejoin_needed ??= false;
  for (const part of doc.parts) {
    part.retake ??= null;
    part.retake_est ??= 0;
    part.retakes ??= 0;
    part.not_before ??= null;
  }
  return doc;
}

/** Inclusive shot ranges. `breaks` are shot counts at which a part ends. */
export function planPartRanges(total: number, partSize: unknown, breaks: unknown): Array<[number, number]> {
  if (partSize !== undefined && breaks !== undefined) refuse("send part_size or breaks, not both");
  const ends: number[] = [];
  if (breaks !== undefined) {
    if (!Array.isArray(breaks)) refuse("breaks must be an array of shot counts");
    let last = 0;
    for (const b of breaks) {
      if (!Number.isInteger(b) || (b as number) <= last || (b as number) >= total) {
        refuse("breaks must be whole numbers, rising, and inside the board");
      }
      ends.push(b as number);
      last = b as number;
    }
    ends.push(total);
  } else {
    if (!Number.isInteger(partSize) || (partSize as number) < 1) refuse("part_size or breaks is required");
    for (let at = partSize as number; at < total; at += partSize as number) ends.push(at);
    ends.push(total);
  }
  if (ends.length > MAX_PARTS) refuse(`this board makes ${ends.length} parts; the limit is ${MAX_PARTS}`);
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (const end of ends) {
    if (end - from > MAX_SCENES_PER_PART) {
      refuse(`part ${ranges.length} has ${end - from} shots; the limit is ${MAX_SCENES_PER_PART}`);
    }
    ranges.push([from, end - 1]);
    from = end;
  }
  return ranges;
}

/** The name buildParentDoc gives a part's project: the film's tag, then the part. */
export function isParentPartProject(project: string): boolean {
  return /_[0-9a-f]{8}_p\d{2,}$/.test(project);
}

export function keyframeBackendForStyle(style: "photoreal" | "anime", explicit?: string): string {
  if (explicit) return explicit;
  return style === "anime" ? "cloud-keyframe" : "keyframe";
}

/** The caller's whole request, so a repeat key with a different body is refused and not ignored. */
export function requestFingerprint(body: CreateParentBody): string {
  const { idempotency_key: _key, ...rest } = body as CreateParentBody & { idempotencyKey?: unknown };
  delete (rest as { idempotencyKey?: unknown }).idempotencyKey;
  return JSON.stringify(rest);
}

export function buildParentDoc(
  filmId: string,
  body: CreateParentBody,
  now: number,
  predictBytes?: (width: number, height: number, seconds: number) => number,
  requestHash = "",
): ParentDoc {
  const project = typeof body.project === "string" ? body.project.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(project)) refuse("project must be 1 to 48 letters, digits, _ or -");
  if (!isObject(body.storyboard) || !Array.isArray(body.storyboard.scenes) || !body.storyboard.scenes.length) {
    refuse("storyboard with scenes is required");
  }
  if (!isObject(body.character_refs)) refuse("character_refs is required");
  const shared = body.shared;
  if (!isObject(shared)) refuse("shared is required");
  if (typeof shared.motion_backend !== "string" || !shared.motion_backend) refuse("shared.motion_backend is required");
  if (shared.style !== "photoreal" && shared.style !== "anime") refuse("shared.style must be photoreal or anime");
  // A mismatch at the join refuses the whole film, so pin the frame before any part spends.
  if (!Number.isInteger(shared.delivery_width) || !Number.isInteger(shared.delivery_height)
    || (shared.delivery_width as number) <= 0 || (shared.delivery_height as number) <= 0) {
    refuse("shared.delivery_width and shared.delivery_height are required: the join refuses films of different frames");
  }
  if ("audio_key" in shared) refuse("shared.audio_key is not supported yet: a bed on the joined film is not built");
  const ceiling = body.spend_ceiling_usd;
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling <= 0) refuse("spend_ceiling_usd is required");
  const perShot = body.cost_usd_per_shot_est;
  if (typeof perShot !== "number" || !Number.isFinite(perShot) || perShot <= 0) {
    refuse("cost_usd_per_shot_est is required: the spend ceiling cannot work without an estimate");
  }
  const scenes = body.storyboard.scenes as ParentScene[];
  const ranges = planPartRanges(scenes.length, body.part_size, body.breaks);
  if (predictBytes) {
    const seconds = scenes.reduce((n, s) => n + (sceneSeconds(s) ?? 0), 0);
    const bytes = predictBytes(shared.delivery_width as number, shared.delivery_height as number, seconds);
    // Refused here, because after the spend the join would refuse it instead.
    if (bytes > ONE_UPLOAD_BYTES) {
      refuse(`this board predicts ${bytes} bytes at this frame, over the ${ONE_UPLOAD_BYTES} one upload carries`);
    }
  }
  const tag = filmId.replace(/^feature-/, "").slice(0, 8);
  const given = body.dialogue_lines === undefined ? [] : body.dialogue_lines;
  if (!Array.isArray(given)) refuse("dialogue_lines must be an array");
  // A board carries its lines on its scenes. Without them here a retake could not change a voice, and the
  // parent could not tell a part that should have captions from one that need not.
  const lines = given.length ? given : scenes.flatMap((s) => {
    const text = (s.dialogue as { text?: unknown } | undefined)?.text;
    return typeof text === "string" && text.trim() ? [{ shot_id: sceneId(s) as string, text: text.trim() }] : [];
  });
  if (scenes.some((s) => { const n = sceneSeconds(s); return typeof n !== "number" || !(n > 0); })) {
    refuse("every scene needs seconds above 0: size and spend are worked out from them");
  }
  const known = new Set(scenes.map(sceneId));
  if (known.has(undefined) || known.size !== scenes.length) refuse("every scene needs its own shot_id");
  for (const line of lines as ParentLine[]) {
    if (!known.has(line?.shot_id)) refuse(`dialogue line names an unknown shot: ${String(line?.shot_id)}`);
  }
  const overrides = body.part_overrides === undefined ? [] : body.part_overrides;
  if (!Array.isArray(overrides)) refuse("part_overrides must be an array");
  for (const o of overrides as PartOverride[]) {
    if (!Number.isInteger(o?.index) || o.index < 0 || o.index >= ranges.length) {
      refuse("part_overrides[].index is outside the parts");
    }
  }
  return {
    version: 1,
    request_hash: requestHash,
    pause_after_first_part: body.pause_after_first_part !== false,
    first_part_released: false,
    join_missing: 0,
    join_started_at: null,
    film_id: filmId,
    project,
    phase: "planned",
    stop_reason: null,
    created_at: now,
    started_at: null,
    finished_at: null,
    spend_ceiling_usd: ceiling,
    cost_usd_per_shot_est: perShot,
    shared: shared as unknown as ParentShared,
    storyboard: body.storyboard as ParentDoc["storyboard"],
    character_refs: body.character_refs,
    dialogue_lines: lines as ParentLine[],
    overrides: overrides as PartOverride[],
    parts: ranges.map(([from, to], index) => ({
      part_id: `${filmId}-p${String(index).padStart(2, "0")}`,
      index,
      // The film's own tag is in the name, or two films of one project would overwrite each other's clips.
      project: `${project}_${tag}_p${String(index).padStart(2, "0")}`,
      shot_from: from,
      shot_to: to,
      status: "pending",
      phase: null,
      shots_done: 0,
      shots_total: to - from + 1,
      cost_est: Math.round((to - from + 1) * perShot * 100) / 100,
      error: null,
      attempts: 0,
      generation: 0,
      claimed_at: null,
      child_film_id: null,
      bundle_key: null,
      output_key: null,
      sidecar_key: null,
      retake: null,
      not_before: null,
      retake_est: 0,
      retakes: 0,
    })),
    join_job_id: null,
    join_attempts: 0,
    join_version: 1,
    rejoin_needed: false,
    output_key: null,
    sidecar_key: null,
    bytes: null,
    duration_seconds: null,
    degraded: null,
    error: null,
  };
}

/** What a submit needs for one part. Shots become shot_01 and up, because a part is its own film. */
export function partInputs(doc: ParentDoc, part: ParentPart): {
  bundleArgs: { storyboard: Record<string, unknown>; characterRefs: Record<string, unknown> };
  submit: Record<string, unknown>;
} {
  const override = doc.overrides.find((o) => o.index === part.index);
  const master = doc.storyboard.scenes.slice(part.shot_from, part.shot_to + 1);
  const rename = new Map<string, string>();
  const scenes = master.map((scene, i) => {
    const shot_id = `shot_${String(i + 1).padStart(2, "0")}`;
    rename.set(String(sceneId(scene)), shot_id);
    // The validator reads id and target_seconds, and a positional id would hide a dropped one.
    return { ...scene, id: shot_id, shot_id, target_seconds: sceneSeconds(scene) };
  });
  const dialogue_lines = doc.dialogue_lines
    .filter((l) => rename.has(l.shot_id))
    .map((l) => ({ ...l, shot_id: rename.get(l.shot_id) as string }));
  const s = doc.shared;
  const isFirst = part.index === 0;
  const isLast = part.index === doc.parts.length - 1;
  const titles = {
    ...(isFirst && s.film_titles?.title ? { title: s.film_titles.title } : {}),
    ...(isLast && s.film_titles?.credits ? { credits: s.film_titles.credits } : {}),
  };
  const cast = override?.cast_loras ?? s.cast_loras;
  const style = s.style;
  return {
    bundleArgs: {
      // The validator derives the project name from the title, the bundle key from that, and the submit door
      // its project from the key. With one title, every part would share a project and overwrite its clips.
      storyboard: { ...doc.storyboard, title: part.project, projectName: part.project, scenes },
      characterRefs: override?.character_refs ?? doc.character_refs,
    },
    submit: {
      project: part.project,
      scenes: scenes.map((sc) => ({ shot_id: sc.shot_id, prompt: sc.prompt, seconds: sc.target_seconds })),
      ...(dialogue_lines.length ? { dialogue_lines } : {}),
      motion_backend: override?.motion_backend ?? s.motion_backend,
      keyframe_backend: keyframeBackendForStyle(style, s.keyframe_backend),
      keyframe_config: { ...s.keyframe_config, style },
      ...(s.motion_config ? { motion_config: s.motion_config } : {}),
      ...(s.finish_config ? { finish_config: s.finish_config } : {}),
      ...(s.film_finish_config ? { film_finish_config: s.film_finish_config } : {}),
      ...(cast ? { cast_loras: cast } : {}),
      ...(Object.keys(titles).length ? { film_titles: titles } : {}),
      ...(s.qualityTier ? { qualityTier: s.qualityTier } : {}),
      delivery_width: s.delivery_width,
      delivery_height: s.delivery_height,
      // A deliberate retry moves the generation, so it does not match the submit it replaces.
      idempotency_key: `${part.part_id}-g${part.generation}`,
      // Keeps paid work on a retry. Nothing to keep on a first run.
      reuse_finished: true,
    },
  };
}

export interface ChildRead {
  phase: string;
  /** The film holds a clip job. false only when the film said so. */
  clips_started?: boolean;
  shots_done: number;
  output_key: string | null;
  sidecar_key: string | null;
  error: string | null;
}

export type JoinRead =
  | { status: "pending" }
  | { status: "missing" }
  | { status: "failed"; error: string }
  | { status: "error"; error: string }
  | { status: "completed"; bytes: number; durationSeconds: number; filmOffsetsSeconds: number[] };

/** A refusal that may pass by itself, such as a full door. It does not use up a join attempt. */
export class JoinTransient extends Error {}

/** The door refused and started nothing: a 4xx. Any other failure of a submit may have spent. */
export class SubmitRefused extends Error {}

/** The door answered that it could not run its checks, and started nothing. The part waits and asks again. */
export class SubmitNotStarted extends Error {}

export interface ParentDeps {
  /** Writes the doc if nobody else wrote since it was read. False means another tick won: stop. */
  save(doc: ParentDoc): Promise<boolean>;
  /** The doc as stored now, and the base of the next save. */
  reload(): Promise<ParentDoc | null>;
  /** The router's spend limit, daily ceiling and storage quota, which a part never passes through. A reason
   *  means hold the part and ask again later. */
  admitSubmit(): Promise<string | null>;
  bundle(args: { storyboard: Record<string, unknown>; characterRefs: Record<string, unknown> }): Promise<string>;
  /** Throws SubmitRefused or SubmitNotStarted when nothing started. Any other throw means the outcome is unknown. */
  start(body: Record<string, unknown>): Promise<string>;
  /** The newest film in this project submitted at or after this time. */
  findChild(project: string, sinceMs: number): Promise<string | null>;
  readChild(filmId: string): Promise<ChildRead | null>;
  /** Starts a part again from its finished film's stills, so their bytes, and every clip's proof, hold.
   *  Throws SubmitRefused when nothing started. */
  startRetake(retake: PartRetake, idempotencyKey: string): Promise<string>;
  /** Draws new stills for a retake, from a bundle of the board as it now stands. Same contract as start. */
  startStills(inputs: StillInputs): Promise<string>;
  /** Advances that keyframes-only job, which nothing else drives. Null if it is gone. */
  readStills(filmId: string): Promise<{ phase: string; keyframes: Array<{ shot_id: string; keyframe_key: string }>; error: string | null } | null>;
  submitJoin(doc: ParentDoc, filmKeys: string[], outputKey: string): Promise<string>;
  readJoin(doc: ParentDoc, jobId: string): Promise<JoinRead>;
  readText(key: string): Promise<string | null>;
  writeText(key: string, text: string): Promise<void>;
}

/** Shift each part's captions by where it starts, then number them from 1. Blank input yields no cue. */
export function mergeSrt(parts: Array<{ text: string; offsetSeconds: number }>): string {
  const stamp = (ms: number): string => {
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  };
  const parse = (h: string, m: string, s: string, ms: string) => +h * 3_600_000 + +m * 60_000 + +s * 1000 + +ms;
  const out: string[] = [];
  let n = 0;
  for (const { text, offsetSeconds } of parts) {
    const shift = Math.round(offsetSeconds * 1000);
    for (const block of text.replace(/\r\n/g, "\n").split(/\n\n+/)) {
      const lines = block.trim().split("\n");
      const at = lines.findIndex((l) => l.includes("-->"));
      if (at < 0) continue;
      const m = lines[at].match(/(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)/);
      if (!m) continue;
      n += 1;
      const start = parse(m[1], m[2], m[3], m[4]) + shift;
      const end = parse(m[5], m[6], m[7], m[8]) + shift;
      out.push(`${n}\n${stamp(start)} --> ${stamp(end)}\n${lines.slice(at + 1).join("\n")}\n`);
    }
  }
  return out.join("\n");
}

const isLive = (p: ParentPart) => p.status === "running" || p.status === "submitting";

/** A retry after a failure before clips is free this many times per part. From the next one, each counts in full. */
export const FREE_RETRIES_PER_PART = 2;

/** Submits the ceiling counts. A part that has run counts at least once, whatever was forgiven. */
function countedAttempts(attempts: number, freeRetries: number | undefined): number {
  return attempts > 0 ? Math.max(1, attempts - (freeRetries ?? 0)) : 0;
}

/** Every submit counts in full, except up to FREE_RETRIES_PER_PART retries of a part that failed before its clips.
 *  A retry keeps proven work, so this reads high: the safe direction for a ceiling. An estimate, never a meter. */
export function committedEstimate(doc: ParentDoc): number {
  return doc.parts.reduce((sum, p) => sum + p.cost_est * countedAttempts(p.attempts, p.free_retries) + p.retake_est, 0);
}

/** What one more plain submit of this part adds to the committed estimate. */
function nextSubmitCost(part: ParentPart): number {
  return part.cost_est * (countedAttempts(part.attempts + 1, part.free_retries) - countedAttempts(part.attempts, part.free_retries));
}

/** Stills first, then the clip. A finished draw puts the part back in line for the retake itself. */
async function readStillsJob(part: ParentPart, retake: PartRetake, deps: ParentDeps): Promise<void> {
  const job = await deps.readStills(retake.still_film_id as string);
  const fail = (error: string) => {
    part.status = "failed";
    part.error = error;
    retake.still_film_id = null;
  };
  if (!job) return fail("the job drawing the new still is gone");
  part.phase = "still";
  if (job.phase === "failed") return fail(job.error ?? "the new still failed");
  if (job.phase !== "done") return;
  const stills = { ...retake.stills };
  for (const k of job.keyframes) stills[k.shot_id] = k.keyframe_key;
  const missing = (retake.still_shots ?? []).filter((s) => !stills[s]);
  if (missing.length) return fail(`the new still job finished without ${missing.join(", ")}`);
  retake.stills = stills;
  retake.still_film_id = null;
  part.status = "pending";
  part.phase = null;
  part.error = null;
}

async function readLiveParts(doc: ParentDoc, deps: ParentDeps): Promise<void> {
  for (const part of doc.parts) {
    if (part.status === "running" && part.retake?.still_film_id) {
      await readStillsJob(part, part.retake, deps);
      continue;
    }
    if (part.status !== "running" || !part.child_film_id) continue;
    const child = await deps.readChild(part.child_film_id);
    if (!child) {
      part.status = "failed";
      part.error = "the part's film job is gone";
      continue;
    }
    part.phase = child.phase;
    part.shots_done = child.shots_done;
    if (child.phase === "failed") {
      // The film's own word, not this doc's last view: a storage problem can stretch that across a paid clip run.
      part.failed_before_clips = child.clips_started === false && child.shots_done === 0;
      part.status = "failed";
      part.error = child.error ?? "the part failed";
    } else if (child.phase === "done") {
      if (!child.output_key) {
        part.status = "failed";
        part.error = "the part finished with no film";
      } else {
        part.status = "done";
        // Held until now, so a retake that fails retries as a retake, not as a full re-render.
        if (part.retake) doc.rejoin_needed = true;
        part.retake = null;
        part.shots_done = part.shots_total;
        part.output_key = child.output_key;
        part.sidecar_key = child.sidecar_key;
      }
    }
  }
}

/** Claim, then submit. Returns false when another tick owns the doc.
 *
 *  Takes an index, and reads the part from the doc each time. A reload replaces doc.parts, so a part object
 *  held across one is no longer in the doc, and writes to it would never be stored. */
async function submitPart(doc: ParentDoc, index: number, deps: ParentDeps, now: number): Promise<boolean> {
  const claim = doc.parts[index];
  claim.status = "submitting";
  claim.claimed_at = now;
  const retake = claim.retake;
  const drawing = !!retake && stillsToDraw(retake);
  // A draw counts at the per-shot estimate, on its own: a draw that is cancelled or fails has still spent.
  const drawCost = drawing && retake ? stillsDrawCount(retake) * doc.cost_usd_per_shot_est : 0;
  if (drawing) {
    claim.retake_est += drawCost;
  } else if (retake) {
    claim.retakes += 1;
    claim.retake_est += retake.shots.length * doc.cost_usd_per_shot_est;
  } else {
    claim.attempts += 1;
  }
  const save = async () => {
    try {
      return await deps.save(doc);
    } catch {
      return false;
    }
  };
  if (!(await save())) return false;
  const outcome: Partial<ParentPart> = {};
  try {
    // Nothing is spent by a bundle, so a failure here is a plain failure.
    const inputs = retake ? null : partInputs(doc, claim);
    if (inputs) outcome.bundle_key = await deps.bundle(inputs.bundleArgs);
    try {
      if (drawing) {
        const { bundleArgs, submit } = partInputs(doc, claim);
        const still_film_id = await deps.startStills({
          bundleArgs,
          submit,
          shots: (retake.still_shots ?? []).filter((s) => !retake.stills?.[s]),
          seed: retake.still_seed as number,
          idempotency_key: `${claim.part_id}-s${retake.still_seed}`,
        });
        // Stored as a whole: the loop below writes this over any fresh copy of the part.
        Object.assign(outcome, { retake: { ...retake, still_film_id }, status: "running", phase: "still", error: null, claimed_at: null, not_before: null });
      } else {
      outcome.child_film_id = retake
        ? await deps.startRetake(retake, `${claim.part_id}-r${claim.retakes}`)
        : await deps.start({ ...inputs?.submit, bundle_key: outcome.bundle_key });
      Object.assign(outcome, { status: "running", phase: retake ? "clips" : "keyframe", error: null, claimed_at: null, not_before: null });
      }
    } catch (e) {
      if (e instanceof SubmitNotStarted) {
        // Spent nothing, so it counts for nothing and no person is needed.
        Object.assign(outcome, { status: "pending", error: e.message, claimed_at: null, not_before: now + NOT_STARTED_BACKOFF_MS });
        if (drawing) outcome.retake_est = claim.retake_est - drawCost;
        else if (!retake) outcome.attempts = claim.attempts - 1;
        else Object.assign(outcome, { retakes: claim.retakes - 1, retake_est: claim.retake_est - retake.shots.length * doc.cost_usd_per_shot_est });
      } else if (!(e instanceof SubmitRefused)) {
        // The door can throw or answer 5xx with work already out. The claim stays, so the stale path can
        // adopt that film if it exists.
        outcome.error = `submit outcome unknown so far: ${e instanceof Error ? e.message : String(e)}`;
      } else {
        throw e;
      }
    }
  } catch (e) {
    Object.assign(outcome, { status: "failed", error: e instanceof Error ? e.message : String(e), claimed_at: null });
  }
  // A poll may have written since the claim, or a write may have thrown. A known film id must not be lost to
  // either. If it still is, the stale path finds the film by its project.
  for (let i = 0; i < 5; i++) {
    Object.assign(doc.parts[index], outcome);
    if (await save()) return true;
    let fresh: ParentDoc | null = null;
    try {
      fresh = await deps.reload();
    } catch {
      continue;
    }
    if (!fresh) return false;
    Object.assign(doc, fresh);
  }
  return false;
}

/** Part projects are unique to this parent, so a film there submitted since the claim can only be this
 *  claim's. Adopting it spends nothing. Only "no such film" needs a person, and it never submits again. */
async function resolveStaleClaims(doc: ParentDoc, deps: ParentDeps, now: number): Promise<void> {
  for (const part of doc.parts) {
    if (part.status !== "submitting" || part.claimed_at === null || now - part.claimed_at < STALE_CLAIM_MS) continue;
    const found = await deps.findChild(part.project, part.claimed_at);
    part.claimed_at = null;
    if (found) {
      // A film found while drawing is the stills job, not the part's film.
      if (part.retake && stillsToDraw(part.retake)) part.retake.still_film_id = found;
      else part.child_film_id = found;
      part.status = "running";
      part.error = null;
    } else {
      part.status = "failed";
      part.error = `submit outcome unknown: no film was found in project ${part.project}, but a submit may have gone out. Check it before retrying, because a retry can buy this part twice`;
    }
  }
}

const joinOutputKey = (doc: ParentDoc) =>
  doc.join_version === 1 ? `renders/${doc.film_id}/film.mp4` : `renders/${doc.film_id}/film-v${doc.join_version}.mp4`;

async function advanceJoin(doc: ParentDoc, deps: ParentDeps, now: number): Promise<void> {
  if (doc.join_job_id) {
    const r = await deps.readJoin(doc, doc.join_job_id);
    const timedOut = doc.join_started_at !== null && now - doc.join_started_at > JOIN_TIMEOUT_MS;
    if (r.status === "pending" && !timedOut) return;
    // A 404 can be transient, so only a streak counts as lost.
    if (r.status === "missing" && !timedOut) {
      doc.join_missing += 1;
      if (doc.join_missing < JOIN_MISSING_STREAK) return;
    }
    doc.join_missing = 0;
    if (r.status === "completed") {
      doc.output_key = joinOutputKey(doc);
      doc.rejoin_needed = false;
      doc.degraded = null;
      doc.bytes = r.bytes;
      doc.duration_seconds = r.durationSeconds;
      await mergeCaptions(doc, r.filmOffsetsSeconds, deps);
      doc.phase = "done";
      doc.finished_at = now;
      return;
    }
    doc.error = r.status === "failed" || r.status === "error"
      ? r.error
      : timedOut ? "the join did not finish in time" : "the join job was lost";
    doc.join_job_id = null;
  }
  if (doc.join_attempts >= MAX_JOIN_ATTEMPTS) {
    // Every part is paid for, so this is not the end: POST /api/film/:id/resume joins again.
    doc.phase = "failed";
    doc.finished_at = now;
    return;
  }
  // Fixed per version, so a re-submit reaches the same container job, which hashes object paths.
  try {
    doc.join_job_id = await deps.submitJoin(doc, doc.parts.map((p) => p.output_key as string), joinOutputKey(doc));
    doc.join_attempts += 1;
    doc.join_started_at = now;
    doc.join_missing = 0;
    doc.error = null;
  } catch (e) {
    doc.error = e instanceof Error ? e.message : String(e);
    if (!(e instanceof JoinTransient)) doc.join_attempts += 1;
  }
}

async function mergeCaptions(doc: ParentDoc, offsets: number[], deps: ParentDeps): Promise<void> {
  const shots = (p: ParentPart) => new Set(
    doc.storyboard.scenes.slice(p.shot_from, p.shot_to + 1).map(sceneId));
  const speaking = doc.parts.filter((p) => doc.dialogue_lines.some((l) => shots(p).has(l.shot_id)));
  // This film's captions or none: the last film's would be out of step with a changed line.
  doc.sidecar_key = null;
  if (!doc.parts.some((p) => p.sidecar_key)) {
    if (speaking.length) doc.degraded = "no caption file: no part produced one";
    return;
  }
  const missing = speaking.filter((p) => !p.sidecar_key).map((p) => p.index);
  const texts: Array<{ text: string; offsetSeconds: number }> = [];
  for (const part of doc.parts) {
    if (!part.sidecar_key) continue;
    const text = await deps.readText(part.sidecar_key);
    if (text === null) {
      missing.push(part.index);
      continue;
    }
    texts.push({ text, offsetSeconds: offsets[part.index] });
  }
  const key = joinOutputKey(doc).replace(/\.mp4$/, ".srt");
  await deps.writeText(key, mergeSrt(texts));
  doc.sidecar_key = key;
  if (missing.length) doc.degraded = `captions are missing for parts ${missing.join(", ")}`;
}

/** One tick, and the only thing that submits: the cron runs it. Safe to run twice at once. */
export async function advanceParent(doc: ParentDoc, deps: ParentDeps, now: number): Promise<ParentDoc> {
  if (doc.phase === "done" || doc.phase === "failed") return doc;
  const before = JSON.stringify(doc);
  await readLiveParts(doc, deps);
  await resolveStaleClaims(doc, deps, now);
  // A write only when something moved, so a poll does not collide with a tick that is submitting.
  const saveIfMoved = async () => {
    if (JSON.stringify(doc) !== before) await deps.save(doc);
  };

  if (doc.parts.every((p) => p.status === "done")) {
    doc.phase = "join";
    doc.stop_reason = null;
    await advanceJoin(doc, deps, now);
    await saveIfMoved();
    return doc;
  }

  const failed = doc.parts.filter((p) => p.status === "failed");
  if (failed.length) {
    doc.stop_reason = `part ${failed[0].index} failed`;
    doc.phase = "stopped";
    await saveIfMoved();
    return doc;
  }

  const firstDone = doc.parts[0].status === "done";
  if (firstDone && doc.pause_after_first_part && !doc.first_part_released) {
    doc.phase = "stopped";
    doc.stop_reason = HOLD_AFTER_FIRST;
    await saveIfMoved();
    return doc;
  }

  if (doc.phase === "planned") {
    doc.phase = "running";
    doc.started_at = now;
  }
  // The first part runs alone, and by default holds for a person after it (above).
  const room = (firstDone ? MAX_PARTS_IN_FLIGHT : 1) - doc.parts.filter(isLive).length;
  const next = doc.parts
    // By index as well as room: a first part waiting out a backoff must not let a later one go ahead of it.
    .filter((p) => p.status === "pending" && (firstDone || p.index === 0) && (p.not_before === null || p.not_before <= now))
    .slice(0, Math.max(0, room))
    .map((p) => p.index);
  for (const index of next) {
    // From the doc each time: a submit can reload it, and another tick may have taken this part.
    const part = doc.parts[index];
    if (part.status !== "pending") continue;
    const cost = part.retake ? retakeNextCost(part.retake, doc.cost_usd_per_shot_est) : nextSubmitCost(part);
    if (committedEstimate(doc) + cost > doc.spend_ceiling_usd) {
      doc.stop_reason = "spend ceiling";
      if (!doc.parts.some(isLive)) doc.phase = "stopped";
      break;
    }
    const held = await deps.admitSubmit();
    if (held) {
      // Held, not failed. The part stays pending and the next tick asks again.
      doc.stop_reason = held;
      break;
    }
    if (doc.stop_reason !== "spend ceiling") doc.stop_reason = null;
    if (!(await submitPart(doc, index, deps, now))) return doc;
  }
  if (!next.length && doc.phase === "running" && doc.stop_reason !== "spend ceiling") doc.stop_reason = null;
  // A refusal in this tick stops the film in this tick, so a reader never sees a failed part in a running film.
  const refused = doc.parts.find((p) => p.status === "failed");
  if (refused) {
    doc.stop_reason = `part ${refused.index} failed`;
    doc.phase = "stopped";
  }
  await saveIfMoved();
  return doc;
}

/** Puts a failed part back in line. Paid work stays, because every part submits with reuse_finished. */
export function retryPart(doc: ParentDoc, index: number): void {
  const part = doc.parts[index];
  if (!part) refuse("no such part");
  if (part.status !== "failed") refuse(`part ${index} is ${part.status}, not failed`);
  // cf#1214: what the failed run bought was stills, which the retry keeps. One full estimate still covers the
  // part, so the retry does not add a second one and trip the ceiling with nothing spent on clips. Only so many:
  // each failed run also paid for GPU time, and a loop must reach the ceiling.
  if (part.failed_before_clips && !part.retake && (part.free_retries ?? 0) < FREE_RETRIES_PER_PART) {
    part.free_retries = (part.free_retries ?? 0) + 1;
  }
  part.failed_before_clips = false;
  part.status = "pending";
  part.generation += 1;
  part.error = null;
  part.child_film_id = null;
  part.phase = null;
  part.shots_done = 0;
  doc.stop_reason = null;
  if (doc.phase === "stopped") doc.phase = "running";
}

export interface RetakeEdits {
  prompt?: unknown;
  line?: unknown;
  voice_id?: unknown;
  new_still?: unknown;
  seed?: unknown;
  rebuy_previous?: unknown;
}

export interface StillInputs {
  bundleArgs: { storyboard: Record<string, unknown>; characterRefs: Record<string, unknown> };
  submit: Record<string, unknown>;
  shots: string[];
  seed: number;
  idempotency_key: string;
}

const stillsDrawCount = (r: PartRetake): number => (r.still_shots ?? []).filter((s) => !r.stills?.[s]).length;
const stillsToDraw = (r: PartRetake): boolean => stillsDrawCount(r) > 0;

/** The next cost of a retake: its draw if one is owed, or its clips. */
const retakeNextCost = (r: PartRetake, perShot: number): number =>
  (stillsToDraw(r) ? stillsDrawCount(r) : r.shots.length) * perShot;

/** The shot before a new still keeps its old end frame, so its clip's proof holds and it is not bought again.
 *  Not one that is itself in the retake: it is being bought, and should end on the new still. */
export function heldEndFrames(
  keyframes: Array<{ shot_id: string; keyframe_key: string }>,
  retake: PartRetake,
  prior?: Record<string, string>,
): Record<string, string> {
  // A hold from an earlier retake stands: that clip's proof names that frame. A shot bought now drops its hold.
  const held: Record<string, string> = {};
  for (const [shot, key] of Object.entries(prior ?? {})) {
    if (!retake.shots.includes(shot)) held[shot] = key;
  }
  keyframes.forEach((k, i) => {
    const next = keyframes[i + 1];
    if (next && retake.stills?.[next.shot_id] && !retake.shots.includes(k.shot_id)) {
      held[k.shot_id] ??= next.keyframe_key;
    }
  });
  return held;
}

/** Marks one shot of a finished part for a new take, and reopens the film. Nothing already delivered moves
 *  until the new join is done. Several shots of one part can wait together. */
export function markRetake(doc: ParentDoc, shotId: string, edits: RetakeEdits, now = 0): void {
  const index = doc.storyboard.scenes.findIndex((s) => sceneId(s) === shotId);
  if (index < 0) refuse(`no shot ${shotId}`);
  const part = doc.parts.find((p) => index >= p.shot_from && index <= p.shot_to) as ParentPart;
  const waiting = part.status === "pending" && part.retake !== null;
  if (part.status !== "done" && !waiting) refuse(`part ${part.index} is ${part.status}; a retake needs a finished part`);
  if (edits.prompt !== undefined && (typeof edits.prompt !== "string" || !edits.prompt.trim())) refuse("prompt must be text");
  if (edits.line !== undefined && (typeof edits.line !== "string" || !edits.line.trim())) refuse("line must be text");
  if (edits.voice_id !== undefined && (typeof edits.voice_id !== "string" || !edits.voice_id.trim())) refuse("voice_id must be text");
  if (edits.new_still !== undefined && typeof edits.new_still !== "boolean") refuse("new_still must be true or false");
  if (edits.seed !== undefined && (!Number.isInteger(edits.seed) || (edits.seed as number) < 0)) refuse("seed must be a whole number");
  if (edits.seed !== undefined && edits.new_still !== true) refuse("seed goes with new_still");
  if (edits.rebuy_previous !== undefined && (typeof edits.rebuy_previous !== "boolean" || edits.new_still !== true)) {
    refuse("rebuy_previous must be true or false, and goes with new_still");
  }
  const local = `shot_${String(index - part.shot_from + 1).padStart(2, "0")}`;
  const retake: PartRetake = part.retake ?? {
    from_film_id: part.child_film_id as string, shots: [], prompts: {}, lines: {}, undo: { prompts: {}, lines: {} },
  };
  if (!(shotId in retake.undo.prompts)) {
    retake.undo.prompts[shotId] = doc.storyboard.scenes[index].prompt;
    const had = doc.dialogue_lines.find((l) => l.shot_id === shotId);
    retake.undo.lines[shotId] = had ? { ...had } : null;
  }
  if (!retake.shots.includes(local)) retake.shots.push(local);
  if (edits.new_still === true) {
    if (!retake.still_shots) retake.still_shots = [];
    if (!retake.still_shots.includes(local)) retake.still_shots.push(local);
    // A shot asked for again gets another draw.
    if (retake.stills) delete retake.stills[local];
    retake.still_seed = typeof edits.seed === "number" ? edits.seed : now % 2_147_483_647;
    // Buys the shot before as well, so it ends on the new still. It counts as a second shot.
    if (edits.rebuy_previous === true && index > part.shot_from) {
      const before = `shot_${String(index - part.shot_from).padStart(2, "0")}`;
      if (!retake.shots.includes(before)) retake.shots.push(before);
      const beforeId = sceneId(doc.storyboard.scenes[index - 1]) as string;
      if (!(beforeId in retake.undo.prompts)) {
        retake.undo.prompts[beforeId] = doc.storyboard.scenes[index - 1].prompt;
        const had = doc.dialogue_lines.find((l) => l.shot_id === beforeId);
        retake.undo.lines[beforeId] = had ? { ...had } : null;
      }
    }
  }
  // The master board follows, so a later plain retry renders what was last asked for.
  if (typeof edits.prompt === "string") {
    retake.prompts[local] = edits.prompt;
    doc.storyboard.scenes[index].prompt = edits.prompt;
  }
  const existing = doc.dialogue_lines.find((l) => l.shot_id === shotId);
  if (typeof edits.line === "string" || typeof edits.voice_id === "string") {
    const text = typeof edits.line === "string" ? edits.line : existing?.text;
    if (!text) refuse(`shot ${shotId} has no line to give a voice`);
    const voice_id = typeof edits.voice_id === "string" ? edits.voice_id : existing?.voice_id;
    retake.lines[local] = { text, ...(voice_id ? { voice_id } : {}) };
    if (existing) {
      existing.text = text;
      if (voice_id) existing.voice_id = voice_id;
    } else {
      doc.dialogue_lines.push({ shot_id: shotId, text, ...(voice_id ? { voice_id } : {}) });
    }
  }
  part.retake = retake;
  part.status = "pending";
  part.phase = null;
  part.error = null;
  // Failed too: a retake is a natural answer to a join that failed for good, and it must be able to join.
  if (doc.phase === "done" || doc.phase === "join" || doc.phase === "failed") {
    doc.join_version += 1;
    doc.join_job_id = null;
    doc.join_attempts = 0;
    doc.join_missing = 0;
    doc.join_started_at = null;
    doc.finished_at = null;
    doc.error = null;
  }
  doc.phase = "running";
  doc.stop_reason = null;
}

/** Drops a retake that has not finished, and puts the part and the board back. Nothing is refunded: a take
 *  that already ran was paid for. */
export function cancelRetake(doc: ParentDoc, index: number, now: number): void {
  const part = doc.parts[index];
  if (!part) refuse("no such part");
  if (!part.retake || (part.status !== "pending" && part.status !== "failed")) {
    refuse(`part ${index} has no waiting retake`);
  }
  const { undo, from_film_id } = part.retake;
  for (const [shotId, prompt] of Object.entries(undo.prompts)) {
    const scene = doc.storyboard.scenes.find((s) => sceneId(s) === shotId) as ParentScene;
    scene.prompt = prompt as string | undefined;
  }
  for (const [shotId, line] of Object.entries(undo.lines)) {
    doc.dialogue_lines = doc.dialogue_lines.filter((l) => l.shot_id !== shotId);
    if (line) doc.dialogue_lines.push(line);
  }
  part.retake = null;
  part.status = "done";
  part.child_film_id = from_film_id;
  part.shots_done = part.shots_total;
  part.phase = "done";
  part.error = null;
  part.not_before = null;
  const allDone = doc.parts.every((p) => p.status === "done");
  doc.stop_reason = null;
  if (allDone && doc.output_key && !doc.rejoin_needed) {
    // The delivered film still matches every part, so there is nothing to join.
    doc.phase = "done";
    doc.finished_at = now;
  } else if (doc.phase === "stopped") {
    doc.phase = "running";
  }
}

/** Scenes and lines for the re-run. Everything not named here comes from the old job unchanged, or the
 *  proof of every other shot would fail. */
export function retakeScenesAndLines<
  S extends { shot_id: string; prompt?: string },
  L extends { shot_id: string; text: string; voice_id?: string },
>(job: { scenes: S[]; dialogue_lines?: L[] }, retake: PartRetake): { scenes: S[]; dialogue_lines: L[] | undefined } {
  const scenes = job.scenes.map((s) => (retake.prompts[s.shot_id] ? { ...s, prompt: retake.prompts[s.shot_id] } : s));
  const lines = [...(job.dialogue_lines ?? [])];
  for (const [shot_id, line] of Object.entries(retake.lines)) {
    const at = lines.findIndex((l) => l.shot_id === shot_id);
    if (at >= 0) lines[at] = { ...lines[at], ...line };
    else lines.push({ shot_id, ...line } as L);
  }
  return { scenes, dialogue_lines: lines.length ? lines : undefined };
}

/** Whether a tick has anything to do for this film. The cron marker follows this. */
export function parentCanAct(doc: ParentDoc): boolean {
  if (doc.phase === "done" || doc.phase === "failed") return false;
  if (doc.phase !== "stopped") return true;
  return doc.parts.some((p) => p.status === "running" || p.status === "submitting");
}

/** Where a cron pass starts, so the same films do not always go first. */
export function rotateFrom<T>(items: T[], start: number): T[] {
  if (!items.length) return items;
  const at = start % items.length;
  return [...items.slice(at), ...items.slice(0, at)];
}

/** The stored shape of a part's jobs, as far as a status read needs it. */
export interface PartJob {
  phase?: string;
  clip_job_id?: string;
  keyframes?: Array<{ shot_id: string; keyframe_key: string }>;
}
export interface PartClipJob {
  shots: Array<{
    shot_id: string;
    status?: string;
    keyframe_key?: string;
    clip_key?: string;
    error?: string;
    attempts?: number;
    delivered_frames?: number;
    delivered_fps?: number;
  }>;
}

/** One part's shots, by master id. Local ids stop here: a caller only ever sees the board's own. */
export function partShotRows(doc: ParentDoc, part: ParentPart, job: PartJob | null, clipJob: PartClipJob | null) {
  const waiting = part.retake && (part.status === "pending" || part.status === "failed");
  return doc.storyboard.scenes.slice(part.shot_from, part.shot_to + 1).map((scene, i) => {
    const local = `shot_${String(i + 1).padStart(2, "0")}`;
    const id = sceneId(scene) as string;
    const clip = clipJob?.shots.find((s) => s.shot_id === local);
    const frames = clip?.delivered_frames;
    const fps = clip?.delivered_fps;
    const line = doc.dialogue_lines.find((l) => l.shot_id === id);
    const inRetake = part.retake?.shots.includes(local);
    return {
      shot_id: id,
      index: part.shot_from + i,
      status: clip?.status ?? "pending",
      seconds: sceneSeconds(scene),
      ...(frames && fps ? { delivered_seconds: Math.round((frames / fps) * 1000) / 1000 } : {}),
      keyframe_key: job?.keyframes?.find((k) => k.shot_id === local)?.keyframe_key ?? clip?.keyframe_key ?? null,
      clip_key: clip?.clip_key ?? null,
      prompt: scene.prompt ?? null,
      line: line?.text ?? null,
      error: clip?.error ?? null,
      ...(typeof clip?.attempts === "number" ? { attempts: clip.attempts } : {}),
      retake_status: inRetake ? (waiting ? "waiting" : "running") : null,
    };
  });
}

/** Carries on past the hold after the first part, or joins again after a join that failed. */
export function resumeParent(doc: ParentDoc): void {
  // A film that can act has nothing to resume, but its cron marker may be lost. Saving it puts that back.
  if (parentCanAct(doc)) return;
  if (doc.phase === "failed" && doc.parts.every((p) => p.status === "done")) {
    doc.phase = "join";
    doc.finished_at = null;
    doc.join_job_id = null;
    doc.join_attempts = 0;
    doc.join_missing = 0;
    doc.error = null;
    return;
  }
  if (doc.stop_reason === HOLD_AFTER_FIRST) {
    doc.first_part_released = true;
    doc.stop_reason = null;
    doc.phase = "running";
    return;
  }
  refuse(`nothing to resume: the film is ${doc.phase}`);
}

/** Raises the ceiling and lets a film stopped by it carry on. A failed part still stops it on the next tick. */
export function raiseCeiling(doc: ParentDoc, value: unknown): void {
  if (doc.phase === "done" || doc.phase === "failed") refuse(`the film is ${doc.phase}`);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= doc.spend_ceiling_usd) {
    refuse(`spend_ceiling_usd must be a number above the current ${doc.spend_ceiling_usd}`);
  }
  doc.spend_ceiling_usd = value;
  if (doc.stop_reason === "spend ceiling") {
    doc.stop_reason = null;
    if (doc.phase === "stopped") doc.phase = "running";
  }
}

const CEILING_BASIS = "estimate: every submit counts in full, except the first 2 retries per part of a run that failed before its clips. Not a meter.";

export type StopCode = "part_failed" | "spend_ceiling" | "first_part_hold" | "gate_held";

/** A stable key for stop_reason, which is free text for a person to read. Absent means not stopped. */
export function stopCode(doc: ParentDoc): StopCode | undefined {
  const reason = doc.stop_reason;
  if (reason === null) return undefined;
  if (reason === "spend ceiling") return "spend_ceiling";
  if (reason === HOLD_AFTER_FIRST) return "first_part_hold";
  if (/^part \d+ failed$/.test(reason)) return "part_failed";
  return "gate_held";
}

/** One row of the film list. No parts and no board, so a phone can read fifty. */
export function parentListRow(doc: ParentDoc) {
  const code = stopCode(doc);
  return {
    film_id: doc.film_id,
    project: doc.project,
    phase: doc.phase,
    stop_reason: doc.stop_reason,
    ...(code ? { stop_code: code } : {}),
    created_at: doc.created_at,
    shots_done: doc.parts.reduce((n, p) => n + p.shots_done, 0),
    shots_total: doc.parts.reduce((n, p) => n + p.shots_total, 0),
  };
}

/** The status view. Constant size per part, and no shot lists. */
export function parentView(doc: ParentDoc, now: number) {
  const started = doc.started_at;
  return {
    film_id: doc.film_id,
    project: doc.project,
    phase: doc.phase,
    stop_reason: doc.stop_reason,
    ...(stopCode(doc) ? { stop_code: stopCode(doc) } : {}),
    created_at: doc.created_at,
    started_at: started,
    elapsed_ms: started === null ? 0 : (doc.finished_at ?? now) - started,
    shots_done: doc.parts.reduce((n, p) => n + p.shots_done, 0),
    shots_total: doc.parts.reduce((n, p) => n + p.shots_total, 0),
    cost_est: Math.round(doc.parts.reduce((n, p) => n + p.cost_est, 0) * 100) / 100,
    cost_actual: null,
    spend_ceiling_usd: doc.spend_ceiling_usd,
    spend_committed_est: Math.round(committedEstimate(doc) * 100) / 100,
    spend_ceiling_basis: CEILING_BASIS,
    parts: doc.parts.map((p) => ({
      part_id: p.part_id,
      index: p.index,
      shot_from: p.shot_from,
      shot_to: p.shot_to,
      status: p.status === "submitting" ? "running" : p.status,
      phase: p.phase,
      shots_done: p.shots_done,
      shots_total: p.shots_total,
      cost_est: p.cost_est,
      cost_actual: null,
      output_key: p.output_key,
      error: p.error,
      // Master ids waiting or in progress. A running part cannot have its retake cancelled.
      retake_shots: p.retake ? Object.keys(p.retake.undo.prompts) : [],
    })),
    // Set only when a join finishes, so during a re-join this is still the film delivered last.
    output_key: doc.output_key,
    sidecar_key: doc.sidecar_key,
    bytes: doc.bytes,
    duration_seconds: doc.duration_seconds,
    degraded: doc.degraded,
    error: doc.error,
  };
}
