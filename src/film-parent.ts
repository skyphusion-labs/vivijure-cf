// A long film built as parts: ordinary film jobs under one parent, joined at the end.
//
// A part is an ordinary film job in its own project. The parent never renders. It decides what to submit
// next, reads each part, and joins the finished films with POST /async/join-films. So a part takes the
// same path every other film takes, and this file holds only order, limits and state.
//
// The parent is a JSON document in R2, written with an etag match. Two ticks can run at once: a poll and
// the cron. A submit spends money, so a tick writes a claim on the part first, and only the tick whose
// claim landed submits. A crash between the submit and the next write leaves a stale claim. The next
// tick looks for the child in that part's own project before it submits again.

export const MAX_SCENES_PER_PART = 40; // The largest film run so far has 20 shots. 40 is a limit, not a proof.
export const MAX_PARTS = 64; // MAX_JOIN_FILMS in containers/video-finish/app.py.
export const MAX_PARTS_IN_FLIGHT = 3;
export const MAX_JOIN_ATTEMPTS = 3;
export const STALE_CLAIM_MS = 120_000;
export const FILM_PARENT_PREFIX = "film-parents/";
export const FILM_PARENT_ACTIVE_PREFIX = "film-parents/active/";

export type ParentPhase = "planned" | "running" | "stopped" | "join" | "done" | "failed";
export type PartStatus = "pending" | "submitting" | "running" | "done" | "failed";

export interface ParentScene {
  shot_id?: string;
  prompt?: string;
  seconds?: number;
  [key: string]: unknown;
}

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
  attempts: number;
  claimed_at: number | null;
  child_film_id: string | null;
  bundle_key: string | null;
  output_key: string | null;
  sidecar_key: string | null;
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
}

export class ParentRefusal extends Error {}

function refuse(message: string): never {
  throw new ParentRefusal(message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

export function keyframeBackendForStyle(style: "photoreal" | "anime", explicit?: string): string {
  if (explicit) return explicit;
  return style === "anime" ? "cloud-keyframe" : "keyframe";
}

export function buildParentDoc(filmId: string, body: CreateParentBody, now: number): ParentDoc {
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
  const lines = body.dialogue_lines === undefined ? [] : body.dialogue_lines;
  if (!Array.isArray(lines)) refuse("dialogue_lines must be an array");
  const known = new Set(scenes.map((s) => s.shot_id));
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
      project: `${project}_p${String(index).padStart(2, "0")}`,
      shot_from: from,
      shot_to: to,
      status: "pending",
      phase: null,
      shots_done: 0,
      shots_total: to - from + 1,
      cost_est: Math.round((to - from + 1) * perShot * 100) / 100,
      error: null,
      attempts: 0,
      claimed_at: null,
      child_film_id: null,
      bundle_key: null,
      output_key: null,
      sidecar_key: null,
    })),
    join_job_id: null,
    join_attempts: 0,
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
    rename.set(String(scene.shot_id), shot_id);
    return { ...scene, shot_id };
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
      scenes: scenes.map((sc) => ({ shot_id: sc.shot_id, prompt: sc.prompt, seconds: sc.seconds })),
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
      // The attempt is in the key, because a deliberate retry must not match the submit it replaces.
      idempotency_key: `${part.part_id}-a${part.attempts}`,
      // Keeps paid work on a retry, and on the re-submit after a lost claim. Nothing to keep on a first run.
      reuse_finished: true,
    },
  };
}

export interface ChildRead {
  phase: string;
  shots_done: number;
  output_key: string | null;
  sidecar_key: string | null;
  error: string | null;
}

export type JoinRead =
  | { status: "pending" }
  | { status: "missing" }
  | { status: "failed"; error: string }
  | { status: "completed"; bytes: number; durationSeconds: number; filmOffsetsSeconds: number[] };

export interface ParentDeps {
  /** Writes the doc if nobody else wrote since it was read. False means another tick won: stop. */
  save(doc: ParentDoc): Promise<boolean>;
  bundle(args: { storyboard: Record<string, unknown>; characterRefs: Record<string, unknown> }): Promise<string>;
  start(body: Record<string, unknown>): Promise<string>;
  readChild(filmId: string): Promise<ChildRead | null>;
  /** The newest film in a part's own project, for a claim left by a crash. */
  findChild(project: string): Promise<string | null>;
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

async function readLiveParts(doc: ParentDoc, deps: ParentDeps): Promise<void> {
  for (const part of doc.parts) {
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
      part.status = "failed";
      part.error = child.error ?? "the part failed";
    } else if (child.phase === "done") {
      if (!child.output_key) {
        part.status = "failed";
        part.error = "the part finished with no film";
      } else {
        part.status = "done";
        part.shots_done = part.shots_total;
        part.output_key = child.output_key;
        part.sidecar_key = child.sidecar_key;
      }
    }
  }
}

/** Claim, then submit. Returns false when another tick owns the doc. */
async function submitPart(doc: ParentDoc, part: ParentPart, deps: ParentDeps, now: number): Promise<boolean> {
  part.status = "submitting";
  part.claimed_at = now;
  part.attempts += 1;
  if (!(await deps.save(doc))) return false;
  try {
    const { bundleArgs, submit } = partInputs(doc, part);
    part.bundle_key = await deps.bundle(bundleArgs);
    part.child_film_id = await deps.start({ ...submit, bundle_key: part.bundle_key });
    part.status = "running";
    part.phase = "keyframe";
    part.error = null;
  } catch (e) {
    part.status = "failed";
    part.error = e instanceof Error ? e.message : String(e);
  }
  part.claimed_at = null;
  return deps.save(doc);
}

async function recoverStaleClaims(doc: ParentDoc, deps: ParentDeps, now: number): Promise<void> {
  for (const part of doc.parts) {
    if (part.status !== "submitting" || part.claimed_at === null || now - part.claimed_at < STALE_CLAIM_MS) continue;
    const found = await deps.findChild(part.project);
    if (found) {
      part.child_film_id = found;
      part.status = "running";
    } else {
      part.status = "pending";
    }
    part.claimed_at = null;
  }
}

async function advanceJoin(doc: ParentDoc, deps: ParentDeps, now: number): Promise<void> {
  if (doc.join_job_id) {
    const r = await deps.readJoin(doc, doc.join_job_id);
    if (r.status === "pending") return;
    if (r.status === "completed") {
      doc.bytes = r.bytes;
      doc.duration_seconds = r.durationSeconds;
      await mergeCaptions(doc, r.filmOffsetsSeconds, deps);
      doc.phase = "done";
      doc.finished_at = now;
      return;
    }
    doc.error = r.status === "failed" ? r.error : "the join job was lost";
    doc.join_job_id = null;
  }
  if (doc.join_attempts >= MAX_JOIN_ATTEMPTS) {
    doc.phase = "failed";
    doc.finished_at = now;
    return;
  }
  doc.join_attempts += 1;
  // Fixed key, so a re-submit reaches the same container job, which hashes object paths.
  doc.output_key = `renders/${doc.film_id}/film.mp4`;
  try {
    doc.join_job_id = await deps.submitJoin(doc, doc.parts.map((p) => p.output_key as string), doc.output_key);
    doc.error = null;
  } catch (e) {
    doc.error = e instanceof Error ? e.message : String(e);
  }
}

async function mergeCaptions(doc: ParentDoc, offsets: number[], deps: ParentDeps): Promise<void> {
  const shots = (p: ParentPart) => new Set(
    doc.storyboard.scenes.slice(p.shot_from, p.shot_to + 1).map((s) => s.shot_id));
  const speaking = doc.parts.filter((p) => doc.dialogue_lines.some((l) => shots(p).has(l.shot_id)));
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
  const key = `renders/${doc.film_id}/film.srt`;
  await deps.writeText(key, mergeSrt(texts));
  doc.sidecar_key = key;
  if (missing.length) doc.degraded = `captions are missing for parts ${missing.join(", ")}`;
}

/** One tick. Safe to run at any time and from two places at once. */
export async function advanceParent(doc: ParentDoc, deps: ParentDeps, now: number): Promise<ParentDoc> {
  if (doc.phase === "done" || doc.phase === "failed") return doc;
  await readLiveParts(doc, deps);
  await recoverStaleClaims(doc, deps, now);

  if (doc.parts.every((p) => p.status === "done")) {
    doc.phase = "join";
    doc.stop_reason = null;
    await advanceJoin(doc, deps, now);
    await deps.save(doc);
    return doc;
  }

  const failed = doc.parts.filter((p) => p.status === "failed");
  if (failed.length) {
    doc.stop_reason = `part ${failed[0].index} failed`;
    doc.phase = "stopped";
    await deps.save(doc);
    return doc;
  }

  if (doc.phase === "planned") {
    doc.phase = "running";
    doc.started_at = now;
  }
  // The first part runs alone: listen before spending on the rest.
  const firstDone = doc.parts[0].status === "done";
  const room = (firstDone ? MAX_PARTS_IN_FLIGHT : 1) - doc.parts.filter(isLive).length;
  const committed = doc.parts.filter((p) => p.status !== "pending").reduce((sum, p) => sum + p.cost_est, 0);
  const next = doc.parts.filter((p) => p.status === "pending").slice(0, Math.max(0, room));
  let spend = committed;
  for (const part of next) {
    if (spend + part.cost_est > doc.spend_ceiling_usd) {
      doc.stop_reason = "spend ceiling";
      if (!doc.parts.some(isLive)) doc.phase = "stopped";
      break;
    }
    spend += part.cost_est;
    if (!(await submitPart(doc, part, deps, now))) return doc;
  }
  await deps.save(doc);
  return doc;
}

/** Puts a failed part back in line. Paid work stays, because every part submits with reuse_finished. */
export function retryPart(doc: ParentDoc, index: number): void {
  const part = doc.parts[index];
  if (!part) refuse("no such part");
  if (part.status !== "failed") refuse(`part ${index} is ${part.status}, not failed`);
  part.status = "pending";
  part.error = null;
  part.child_film_id = null;
  part.phase = null;
  part.shots_done = 0;
  doc.stop_reason = null;
  if (doc.phase === "stopped") doc.phase = "running";
}

/** The status view. Constant size per part, and no shot lists. */
export function parentView(doc: ParentDoc, now: number) {
  const started = doc.started_at;
  return {
    film_id: doc.film_id,
    project: doc.project,
    phase: doc.phase,
    stop_reason: doc.stop_reason,
    created_at: doc.created_at,
    started_at: started,
    elapsed_ms: started === null ? 0 : (doc.finished_at ?? now) - started,
    shots_done: doc.parts.reduce((n, p) => n + p.shots_done, 0),
    shots_total: doc.parts.reduce((n, p) => n + p.shots_total, 0),
    cost_est: Math.round(doc.parts.reduce((n, p) => n + p.cost_est, 0) * 100) / 100,
    cost_actual: null,
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
    })),
    output_key: doc.phase === "done" ? doc.output_key : null,
    sidecar_key: doc.sidecar_key,
    bytes: doc.bytes,
    duration_seconds: doc.duration_seconds,
    degraded: doc.degraded,
    error: doc.error,
  };
}
