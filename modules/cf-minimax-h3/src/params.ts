// minimax/h3 via Cloudflare AI Gateway.
//
// Page read 2026-10-30: https://developers.cloudflare.com/ai/models/minimax/h3/
// Schema: https://developers.cloudflare.com/ai/models/minimax/h3/schema-input.json
//
// Required: content, resolution, duration. Ratio is optional and has no default.
// The image examples send ratio "adaptive". Duration is an integer from 4 to 15
// and the schema states no default. Resolution is 768P or 2K and the schema
// states no default; 768P matches the default per-second price. There is no
// audio-output field. reference_image, reference_video, and reference_audio
// exist on the schema. This hook has a start still and an optional end still,
// so those roles are not sent.

import type { MotionBackendInput } from "./contract";
import { mp4VideoTiming } from "../../_shared/mp4-timing";

export const MODEL = "minimax/h3";
export const MIN_DURATION = 4;
export const MAX_DURATION = 15;
export const MAX_PROMPT = 7000;
export const RESOLUTIONS = ["768P", "2K"] as const;
/** Schema lists no default. 768P is the default per-second price on the page. */
export const DEFAULT_RESOLUTION = "768P";
export const RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
/** Schema lists no default. The first-frame and first-and-last examples send adaptive. */
export const DEFAULT_RATIO = "adaptive";

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
  if (!Number.isFinite(n)) return MIN_DURATION;
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

type ContentItem =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string }; role: "first_frame" | "last_frame" };

/** Start still, optional end still. Never a reference image, video, or audio. */
export function buildParams(input: MotionBackendInput, config: ModuleConfig): Record<string, unknown> {
  const content: ContentItem[] = [
    { type: "text", text: input.prompt },
    { type: "image_url", image_url: { url: input.keyframe_url }, role: "first_frame" },
  ];
  if (input.last_keyframe_url) {
    content.push({ type: "image_url", image_url: { url: input.last_keyframe_url }, role: "last_frame" });
  }
  return {
    content,
    duration: clampDuration(input.seconds),
    resolution: config.resolution,
    ratio: config.ratio,
  };
}

/** Documented success shape is task.status "succeeded" and task.content.url. */
export function parseVideoUrl(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const task = (result as Record<string, unknown>).task;
  if (!task || typeof task !== "object" || Array.isArray(task)) return null;
  const t = task as Record<string, unknown>;
  if (t.status !== "succeeded") return null;
  const content = t.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const url = (content as Record<string, unknown>).url;
  if (typeof url === "string" && url.length > 0) return url;
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
export function stateKey(jobId: string): string { return `cf-minimax-h3/${jobId}.state.json`; }
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_cf-minimax-h3.mp4`;
}
