// Alibaba Wan 2.7 i2v via CF AI Gateway.

import type { MotionBackendInput } from "./contract";

export const MODEL = "alibaba/wan-2.7-i2v";
export const OUT_FPS = 24;
export const MIN_DURATION = 2;
export const MAX_DURATION = 15;
export const RESOLUTIONS = ["720P", "1080P"] as const;
export const DEFAULT_RESOLUTION = "720P";

export type ModuleConfig = {
  resolution: (typeof RESOLUTIONS)[number];
  seed?: number;
  watermark?: boolean;
};

export type RunState =
  | { status: "running"; started_at: number; project: string; shot_id: string; seconds: number; workflow_id?: string }
  | { status: "done"; project: string; shot_id: string; seconds: number; clip_key: string }
  | { status: "failed"; error: string };

export interface PollToken { job_id: string; }

export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds) || 5);
  return Math.max(MIN_DURATION, Math.min(MAX_DURATION, n));
}

export function normalizeConfig(raw: Record<string, unknown>): ModuleConfig {
  const res = String(raw.resolution ?? DEFAULT_RESOLUTION);
  return {
    resolution: (RESOLUTIONS as readonly string[]).includes(res) ? (res as ModuleConfig["resolution"]) : DEFAULT_RESOLUTION,
    seed: typeof raw.seed === "number" && raw.seed >= 0 ? Math.floor(raw.seed) : undefined,
    watermark: raw.watermark === true,
  };
}

export function buildParams(input: MotionBackendInput, config: ModuleConfig): Record<string, unknown> {
  const params: Record<string, unknown> = {
    image: input.keyframe_url,
    prompt: input.prompt,
    duration: clampDuration(input.seconds),
    resolution: config.resolution,
    watermark: false,
  };
  if (typeof config.seed === "number") params.seed = config.seed;
  return params;
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
export function stateKey(jobId: string): string { return `cf-wan-27/${jobId}.state.json`; }
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_cf-wan-27.mp4`;
}
