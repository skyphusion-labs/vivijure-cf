// pruna/p-video-avatar via Cloudflare AI Gateway.
//
// Page read 2026-10-30: https://developers.cloudflare.com/ai/models/pruna/p-video-avatar/
// Schema: https://developers.cloudflare.com/ai/models/pruna/p-video-avatar/schema-input.json
//
// The schema has no duration and no aspect ratio. Audio is optional there and
// required here: this door is the Cast-audio path, and voice_script would
// invent a line. If both are sent, the page says audio takes priority, so
// voice_script is the empty string.

import type { MotionBackendInput } from "./contract";
import { mp4VideoTiming } from "../../_shared/mp4-timing";

export const MODEL = "pruna/p-video-avatar";

/** Schema default. Required even when audio is sent. */
export const DEFAULT_VOICE = "Zephyr (Female)";
export const DEFAULT_VOICE_LANGUAGE = "English (US)";
export const DEFAULT_VOICE_PROMPT = "Say the following.";
export const RESOLUTIONS = ["720p", "1080p"] as const;
export const DEFAULT_RESOLUTION = "720p";

export type ModuleConfig = {
  resolution: (typeof RESOLUTIONS)[number];
};

export type RunState =
  | { status: "running"; started_at: number; project: string; shot_id: string; workflow_id?: string }
  | { status: "done"; project: string; shot_id: string; clip_key: string; fps: number; frames: number }
  | { status: "failed"; error: string };

export interface PollToken { job_id: string; }

export function normalizeConfig(raw: Record<string, unknown>): ModuleConfig {
  const res = String(raw.resolution ?? DEFAULT_RESOLUTION);
  return {
    resolution: (RESOLUTIONS as readonly string[]).includes(res)
      ? (res as ModuleConfig["resolution"])
      : DEFAULT_RESOLUTION,
  };
}

/**
 * env.AI.run params. No duration key: the schema has none, and inventing one
 * would be a field the provider rejects (additionalProperties is open, but a
 * duration we made up is still a claim).
 */
export function buildParams(input: MotionBackendInput, config: ModuleConfig): Record<string, unknown> {
  return {
    image: input.keyframe_url,
    audio: input.audio_url,
    voice: DEFAULT_VOICE,
    voice_script: "",
    voice_language: DEFAULT_VOICE_LANGUAGE,
    resolution: config.resolution,
    video_prompt: input.prompt,
    voice_prompt: DEFAULT_VOICE_PROMPT,
    negative_prompt: "",
    strength_negative_prompt: 0.5,
    disable_safety_filter: false,
    disable_prompt_upsampling: false,
  };
}

/** Documented completion shape is result.video. Do not grab the first URL. */
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

/** Measured from the file. Null when the container cannot be read. Never 24. */
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
export function stateKey(jobId: string): string { return `cf-p-video-avatar/${jobId}.state.json`; }
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_cf-p-video-avatar.mp4`;
}
