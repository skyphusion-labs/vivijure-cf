// Google Veo 3.1 Fast via CF AI Gateway.

import type { MotionBackendInput } from "./contract";

export const MODEL = "google/veo-3.1-fast";
export const OUT_FPS = 24;

export type ModuleConfig = {
  generate_audio: boolean;
  aspect_ratio: "16:9" | "9:16" | "1:1";
  resolution: "720p" | "1080p";
};

export type RunState =
  | { status: "running"; started_at: number; project: string; shot_id: string; seconds: number; workflow_id?: string }
  | { status: "done"; project: string; shot_id: string; seconds: number; clip_key: string; has_audio?: boolean }
  | { status: "failed"; error: string };

export interface PollToken { job_id: string; }

export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds) || 6);
  if (n <= 5) return 4;
  if (n <= 7) return 6;
  return 8;
}

export function normalizeConfig(raw: Record<string, unknown>): ModuleConfig {
  const ar = raw.aspect_ratio;
  return {
    generate_audio: raw.generate_audio !== false,
    aspect_ratio: ar === "9:16" || ar === "1:1" ? ar : "16:9",
    resolution: raw.resolution === "1080p" ? "1080p" : "720p",
  };
}

export function buildParams(input: MotionBackendInput, config: ModuleConfig): Record<string, unknown> {
  return {
    prompt: input.prompt,
    image_input: input.keyframe_url,
    duration: clampDuration(input.seconds) + "s",
    aspect_ratio: config.aspect_ratio,
    resolution: config.resolution,
    generate_audio: config.generate_audio,
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
export function stateKey(jobId: string): string { return `cf-veo/${jobId}.state.json`; }
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_cf-veo.mp4`;
}
