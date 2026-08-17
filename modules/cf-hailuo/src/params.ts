// MiniMax Hailuo 2.3 via CF AI Gateway.

import type { MotionBackendInput } from "./contract";

export const MODEL = "minimax/hailuo-2.3";
export const OUT_FPS = 24;

export type ModuleConfig = {
  resolution: "768P" | "1080P";
  prompt_optimizer: boolean;
  fast_pretreatment: boolean;
};

export type RunState =
  | { status: "running"; started_at: number; project: string; shot_id: string; seconds: number; workflow_id?: string }
  | { status: "done"; project: string; shot_id: string; seconds: number; clip_key: string }
  | { status: "failed"; error: string };

export interface PollToken { job_id: string; }

export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds) || 6);
  return n <= 8 ? 6 : 10;
}

export function normalizeConfig(raw: Record<string, unknown>): ModuleConfig {
  return {
    resolution: raw.resolution === "1080P" ? "1080P" : "768P",
    prompt_optimizer: raw.prompt_optimizer !== false,
    fast_pretreatment: raw.fast_pretreatment === true,
  };
}

export function buildParams(input: MotionBackendInput, config: ModuleConfig): Record<string, unknown> {
  return {
    prompt: input.prompt,
    first_frame_image: input.keyframe_url,
    duration: clampDuration(input.seconds),
    resolution: config.resolution,
    prompt_optimizer: config.prompt_optimizer,
    fast_pretreatment: config.fast_pretreatment,
  };
}

export function parseVideoUrl(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.video === "string" && r.video.length > 0) return r.video;
  const inner = r.result;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const v = (inner as Record<string, unknown>).video;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export function encodePoll(t: PollToken): string { return btoa(JSON.stringify(t)); }
export function decodePoll(token: string): PollToken | null {
  try {
    const o = JSON.parse(atob(token)) as PollToken;
    if (o && typeof o.job_id === "string" && o.job_id.length > 0) return { job_id: o.job_id };
  } catch { /* */ }
  return null;
}
export function stateKey(jobId: string): string { return `cf-hailuo/${jobId}.state.json`; }
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_cf-hailuo.mp4`;
}
