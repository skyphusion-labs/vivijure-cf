// Pure helpers for cf-grok-video: xAI Grok Imagine Video via CF AI Gateway.
// Model: xai/grok-imagine-video
// Schema (CF): prompt, duration 1-15, aspect_ratio, resolution 480p/720p, image {object}, reference_images[].
// We pass the keyframe as image: { url: keyframe_url } (CF object field).

import type { MotionBackendInput } from "./contract";

export const MODEL = "xai/grok-imagine-video";
export const OUT_FPS = 24;
export const MIN_DURATION = 1;
export const MAX_DURATION = 15;
export const RESOLUTIONS = ["480p", "720p"] as const;
export const DEFAULT_RESOLUTION = "720p";
export const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export const DEFAULT_ASPECT = "16:9";

export type ModuleConfig = {
  resolution: (typeof RESOLUTIONS)[number];
  aspect_ratio: (typeof ASPECT_RATIOS)[number];
};

export type RunState =
  | { status: "running"; started_at: number; project: string; shot_id: string; seconds: number; workflow_id?: string }
  | { status: "done"; project: string; shot_id: string; seconds: number; clip_key: string; has_audio?: boolean }
  | { status: "failed"; error: string };

export interface PollToken { job_id: string; }

export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds) || 5);
  return Math.max(MIN_DURATION, Math.min(MAX_DURATION, n));
}

export function normalizeConfig(raw: Record<string, unknown>): ModuleConfig {
  const res = String(raw.resolution ?? DEFAULT_RESOLUTION);
  const ar = String(raw.aspect_ratio ?? DEFAULT_ASPECT);
  return {
    resolution: (RESOLUTIONS as readonly string[]).includes(res) ? (res as ModuleConfig["resolution"]) : DEFAULT_RESOLUTION,
    aspect_ratio: (ASPECT_RATIOS as readonly string[]).includes(ar) ? (ar as ModuleConfig["aspect_ratio"]) : DEFAULT_ASPECT,
  };
}

export function buildParams(
  input: MotionBackendInput,
  config: ModuleConfig,
  uploadUrl?: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    prompt: input.prompt,
    duration: clampDuration(input.seconds),
    aspect_ratio: config.aspect_ratio,
    resolution: config.resolution,
    image: { url: input.keyframe_url },
  };
  // xAI ZDR teams cannot store video on xAI. They require output.upload_url; xAI PUTs the mp4 there.
  if (uploadUrl) params.output = { upload_url: uploadUrl };
  return params;
}

export function parseVideoUrl(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.state === "string" && r.state.length > 0 && r.state !== "Completed") return null;
  if (typeof r.video === "string" && r.video.length > 0) return r.video;
  const inner = r.result;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const v = (inner as Record<string, unknown>).video;
    if (typeof v === "string" && v.length > 0) return v;
  }
  let firstHttp: string | null = null;
  const visit = (v: unknown): string | null => {
    if (typeof v === "string") {
      if (/^https?:\/\/\S+\.mp4(\?|$)/i.test(v)) return v;
      if (firstHttp === null && /^https?:\/\//i.test(v)) firstHttp = v;
      return null;
    }
    if (Array.isArray(v)) {
      for (const x of v) { const hit = visit(x); if (hit) return hit; }
      return null;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) {
        const hit = visit(x);
        if (hit) return hit;
      }
    }
    return null;
  };
  return visit(result) ?? firstHttp;
}

export function encodePoll(t: PollToken): string {
  return btoa(JSON.stringify(t));
}
export function decodePoll(token: string): PollToken | null {
  try {
    const o = JSON.parse(atob(token)) as PollToken;
    if (o && typeof o.job_id === "string" && o.job_id.length > 0) return { job_id: o.job_id };
  } catch { /* fall through */ }
  return null;
}

export function stateKey(jobId: string): string {
  return `cf-grok-video/${jobId}.state.json`;
}
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_cf-grok-video.mp4`;
}
