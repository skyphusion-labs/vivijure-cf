// Pure helpers for cf-hh1-r2v: Alibaba HappyHorse 1.1 R2V via CF AI Gateway.
// Model: alibaba/hh1.1-r2v -- images[] (1-9 refs), prompt, duration 3-15, ratio, resolution 720P/1080P.
// Motion.backend supplies one keyframe_url; it becomes images[0]. Multi-ref cast packing is a later add.

import type { MotionBackendInput } from "./contract";

export const MODEL = "alibaba/hh1.1-r2v";
export const OUT_FPS = 24;
export const MIN_DURATION = 3;
export const MAX_DURATION = 15;
export const RESOLUTIONS = ["720P", "1080P"] as const;
export const DEFAULT_RESOLUTION = "720P";
export const RATIOS = ["16:9", "9:16", "3:4", "4:3", "1:1", "21:9", "9:21", "5:4", "4:5"] as const;
export const DEFAULT_RATIO = "16:9";

export type ModuleConfig = {
  resolution: (typeof RESOLUTIONS)[number];
  ratio: (typeof RATIOS)[number];
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
  const ratio = String(raw.ratio ?? DEFAULT_RATIO);
  return {
    resolution: (RESOLUTIONS as readonly string[]).includes(res) ? (res as ModuleConfig["resolution"]) : DEFAULT_RESOLUTION,
    ratio: (RATIOS as readonly string[]).includes(ratio) ? (ratio as ModuleConfig["ratio"]) : DEFAULT_RATIO,
    // -1 (and any negative) = omit seed so the provider randomizes.
    seed: typeof raw.seed === "number" && raw.seed >= 0 ? Math.floor(raw.seed) : undefined,
    watermark: raw.watermark === true,
  };
}

/** env.AI.run params for hh1.1-r2v. keyframe is images[0]. */
export function buildParams(input: MotionBackendInput, config: ModuleConfig): Record<string, unknown> {
  const params: Record<string, unknown> = {
    prompt: input.prompt,
    images: input.last_keyframe_url
      ? [input.keyframe_url, input.last_keyframe_url]
      : [input.keyframe_url],
    duration: clampDuration(input.seconds),
    ratio: config.ratio,
    resolution: config.resolution,
  };
  if (typeof config.seed === "number") params.seed = config.seed;
  if (config.watermark) params.watermark = true;
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
  // Prefer .mp4 over first http
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
  return `cf-hh1-r2v/${jobId}.state.json`;
}
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_cf-hh1-r2v.mp4`;
}
