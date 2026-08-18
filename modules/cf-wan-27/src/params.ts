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

export type AlibabaMedia = { type: "first_frame" | "last_frame" | "driving_audio"; url: string };

/**
 * CF publishes a flat i2v postcard (image, prompt, duration). Alibaba Wan 2.7
 * is first_frame + optional last_frame + optional driving_audio. CF Workers AI
 * is a passthrough to Alibaba. We send BOTH shapes: keep `image` so a strict
 * CF schema still runs, and send `media[]` so a proxy can lip-sync.
 *
 * Without driving_audio Alibaba invents speech. With it, lips follow the file.
 */
export function buildAlibabaMedia(input: MotionBackendInput): AlibabaMedia[] {
  const media: AlibabaMedia[] = [{ type: "first_frame", url: input.keyframe_url }];
  if (input.last_keyframe_url) media.push({ type: "last_frame", url: input.last_keyframe_url });
  if (input.voice_ref_url) media.push({ type: "driving_audio", url: input.voice_ref_url });
  return media;
}

export function buildParams(input: MotionBackendInput, config: ModuleConfig): Record<string, unknown> {
  const media = buildAlibabaMedia(input);
  const params: Record<string, unknown> = {
    image: input.keyframe_url,
    prompt: input.prompt,
    duration: clampDuration(input.seconds),
    resolution: config.resolution,
    watermark: false,
    media,
  };
  if (typeof config.seed === "number") params.seed = config.seed;
  const last = media.find((m) => m.type === "last_frame");
  const audio = media.find((m) => m.type === "driving_audio");
  if (last) params.last_frame = last.url;
  if (audio) params.driving_audio = audio.url;
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
