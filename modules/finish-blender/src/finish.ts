// Pure finish-blender logic: RunPod body, output key, poll token. No I/O.

import type { FinishInput, FinishOutput } from "./contract";

export function passthroughOutput(
  input: FinishInput,
  reason: string,
  opts: { degraded?: boolean; detail?: string } = {},
): FinishOutput {
  const degraded = opts.degraded ?? true;
  const out: FinishOutput = {
    shot_id: input.shot_id,
    clip_key: input.clip_key,
    out_fps: input.src_fps ?? 24,
    frames: input.frames ?? 0,
    applied: [`${degraded ? "passthrough" : "noop"}:${reason}`],
  };
  if (degraded) out.degraded = opts.detail ? `${reason}: ${opts.detail}` : reason;
  return out;
}

export const PRESETS = ["neutral", "filmic_warm", "high_contrast", "cool", "soft"] as const;
export const JOB_TYPES = ["grade", "composite"] as const;

export interface BlenderConfig {
  job_type: (typeof JOB_TYPES)[number];
  preset: (typeof PRESETS)[number];
  strength: number;
}

export function defaultConfig(): BlenderConfig {
  return { job_type: "grade", preset: "filmic_warm", strength: 1 };
}

export function coerceConfig(cfg: Record<string, unknown>): BlenderConfig {
  const base = defaultConfig();
  const jt = String(cfg.job_type ?? base.job_type);
  const pr = String(cfg.preset ?? base.preset);
  let strength = Number(cfg.strength ?? base.strength);
  if (!Number.isFinite(strength)) strength = base.strength;
  strength = Math.max(0, Math.min(2, strength));
  return {
    job_type: (JOB_TYPES as readonly string[]).includes(jt)
      ? (jt as BlenderConfig["job_type"])
      : base.job_type,
    preset: (PRESETS as readonly string[]).includes(pr)
      ? (pr as BlenderConfig["preset"])
      : base.preset,
    strength,
  };
}

/** graded clip lands beside the source with `_bl` suffix. */
export function blenderKey(clipKey: string): string {
  const dot = clipKey.lastIndexOf(".");
  return dot > clipKey.lastIndexOf("/")
    ? `${clipKey.slice(0, dot)}_bl${clipKey.slice(dot)}`
    : `${clipKey}_bl`;
}

export function buildRunPodBody(
  input: FinishInput,
  cfg: BlenderConfig,
  project: string,
): { input: Record<string, unknown> } {
  return {
    input: {
      project,
      shot_id: input.shot_id,
      clip_key: input.clip_key,
      output_key: blenderKey(input.clip_key),
      job_type: cfg.job_type,
      preset: cfg.preset,
      strength: cfg.strength,
      ...(input.output_hash ? { output_hash: input.output_hash } : {}),
    },
  };
}

export interface PollState {
  jobId: string;
  shotId: string;
  srcFps: number;
  frames: number;
  submittedAt?: number;
}

export function encodePoll(s: PollState): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): PollState | null {
  try {
    const o = JSON.parse(atob(token)) as PollState;
    if (o && typeof o.jobId === "string" && typeof o.shotId === "string") {
      return {
        jobId: o.jobId,
        shotId: o.shotId,
        srcFps: Number(o.srcFps) || 16,
        frames: Number(o.frames) || 0,
        submittedAt: typeof o.submittedAt === "number" ? o.submittedAt : undefined,
      };
    }
  } catch { /* fall through */ }
  return null;
}

export const RUNPOD_NOTFOUND_GRACE_MS = 150_000;
export const RUNPOD_COLD_GRACE_MS = 900_000;

export function runpodJobGone(
  httpStatus: number,
  body: { status?: unknown; title?: unknown } | null,
): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false;
  if (typeof st === "number") return st === 404;
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed";
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}

export interface BackendOutput {
  shot_id?: string;
  clip_key?: string;
  out_fps?: number;
  frames?: number;
  applied?: string[];
}

export function parseBackendOutput(output: unknown): BackendOutput | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  return {
    shot_id: typeof o.shot_id === "string" ? o.shot_id : undefined,
    clip_key: typeof o.clip_key === "string" ? o.clip_key : undefined,
    out_fps: typeof o.out_fps === "number" ? o.out_fps : undefined,
    frames: typeof o.frames === "number" ? o.frames : undefined,
    applied: Array.isArray(o.applied) ? (o.applied as string[]) : [],
  };
}

export function workersStillCold(health: unknown): boolean {
  if (!health || typeof health !== "object") return false;
  const w = (health as Record<string, unknown>).workers;
  if (!w || typeof w !== "object") return false;
  const n = (k: string): number => {
    const v = (w as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const up = n("ready") + n("idle") + n("running");
  const coming = n("initializing") + n("throttled");
  return up === 0 && coming > 0;
}

export function terminalErrorInOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const err = o.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const msg = typeof e.message === "string" && e.message.length > 0
      ? e.message
      : JSON.stringify(e).slice(0, 200);
    const stage = typeof e.stage === "string" && e.stage.length > 0 ? " (stage: " + e.stage + ")" : "";
    return msg + stage;
  }
  if (typeof err === "string" && err.length > 0) return err;
  if (o.status === "error") return "backend reported status=error with no error detail";
  // satellite returns { ok: false, error: "..." } inside output
  if (o.ok === false && typeof o.error === "string") return o.error;
  return null;
}
