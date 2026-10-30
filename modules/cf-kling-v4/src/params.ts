// klingai/kling-v4 via Cloudflare AI Gateway.
//
// Page read 2026-10-30: https://developers.cloudflare.com/ai/models/klingai/kling-v4/
// Schema: https://developers.cloudflare.com/ai/models/klingai/kling-v4/schema-input.json
//
// Duration is an integer, 3 to 30. There is no audio input. Aspect is required
// and the page says it is ignored when keyframes are given. middle_frames
// allows up to 9 items. This hook has a start still and an optional end still,
// so middle frames are not sent.

import type { MotionBackendInput } from "./contract";
import { mp4VideoTiming } from "../../_shared/mp4-timing";

export const MODEL = "klingai/kling-v4";
export const MIN_DURATION = 3;
export const MAX_DURATION = 30;
export const MAX_PROMPT = 26000;
export const RESOLUTIONS = ["720p", "1080p"] as const;
/** Schema default. The default per-second price on the page is the 1080p rate. */
export const DEFAULT_RESOLUTION = "1080p";
export const RATIOS = ["21:9", "16:9", "9:16", "1:1"] as const;
export const DEFAULT_RATIO = "16:9";

export type ModuleConfig = {
  resolution: (typeof RESOLUTIONS)[number];
  ratio: (typeof RATIOS)[number];
};

export type RunState =
  | { status: "running"; started_at: number; project: string; shot_id: string; seconds: number; workflow_id?: string }
  | { status: "done"; project: string; shot_id: string; seconds: number; clip_key: string; fps: number; frames: number }
  | { status: "failed"; error: string };

export interface PollToken { job_id: string; }

export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds));
  if (!Number.isFinite(n)) return 5;
  return Math.max(MIN_DURATION, Math.min(MAX_DURATION, n));
}

export function normalizeConfig(raw: Record<string, unknown>): ModuleConfig {
  const res = String(raw.resolution ?? DEFAULT_RESOLUTION);
  const ratio = String(raw.ratio ?? DEFAULT_RATIO);
  return {
    resolution: (RESOLUTIONS as readonly string[]).includes(res) ? (res as ModuleConfig["resolution"]) : DEFAULT_RESOLUTION,
    ratio: (RATIOS as readonly string[]).includes(ratio) ? (ratio as ModuleConfig["ratio"]) : DEFAULT_RATIO,
  };
}

/** Integer seconds, start still, optional end still. Never middle_frames. Never audio. */
export function buildParams(input: MotionBackendInput, config: ModuleConfig): Record<string, unknown> {
  const params: Record<string, unknown> = {
    prompt: input.prompt,
    duration: clampDuration(input.seconds),
    aspect_ratio: config.ratio,
    resolution: config.resolution,
    first_frame: input.keyframe_url,
  };
  if (input.last_keyframe_url) params.last_frame = input.last_keyframe_url;
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

export function clipTiming(bytes: Uint8Array): { fps: number; frames: number } | null {
  const t = mp4VideoTiming(bytes);
  if (!t || t.fps === null || !(t.frames > 0) || !(t.fps > 0)) return null;
  return { fps: t.fps, frames: t.frames };
}

export function encodePoll(t: PollToken): string { return btoa(JSON.stringify(t)); }
export function decodePoll(token: string): PollToken | null {
  try {
    const o = JSON.parse(atob(token)) as PollToken;
    if (o && typeof o.job_id === "string" && o.job_id.length > 0) return { job_id: o.job_id };
  } catch { /* */ }
  return null;
}
export function stateKey(jobId: string): string { return `cf-kling-v4/${jobId}.state.json`; }
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_cf-kling-v4.mp4`;
}
