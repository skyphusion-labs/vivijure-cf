// Pure helpers for cf-seedance: ByteDance Seedance 2.0 family via CF AI Gateway.
// Distinct from modules/seedance (RunPod Seedance V1.5 Pro).
// Models: bytedance/seedance-2.0 | seedance-2.0-fast | seedance-2.0-mini
// i2v field: image; duration 4-12; resolution 480p/720p/1080p/4k (mini caps may apply provider-side).
// use_virtual_avatar: ByteDance blocks faces as "real person" (7003 PrivacyInformation)
// unless this flag routes the still through their virtual-avatar library. Our keyframes
// are always synthetic.

import type { MotionBackendInput } from "./contract";

export const MODELS = [
  "bytedance/seedance-2.0",
  "bytedance/seedance-2.0-fast",
  "bytedance/seedance-2.0-mini",
] as const;
export const DEFAULT_MODEL = "bytedance/seedance-2.0";
/** MODEL is the default; runtime uses config.model. Kept for tag parity with other modules. */
export const MODEL = DEFAULT_MODEL;
export const OUT_FPS = 24;
export const MIN_DURATION = 4;
export const MAX_DURATION = 12;
export const RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;
export const DEFAULT_RESOLUTION = "720p";
export const ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "9:21"] as const;
export const DEFAULT_ASPECT = "16:9";

export type ModuleConfig = {
  model: (typeof MODELS)[number];
  resolution: (typeof RESOLUTIONS)[number];
  aspect_ratio: (typeof ASPECT_RATIOS)[number];
  camera_fixed: boolean;
  generate_audio: boolean;
  seed: number;
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
  const model = String(raw.model ?? DEFAULT_MODEL);
  const res = String(raw.resolution ?? DEFAULT_RESOLUTION);
  const ar = String(raw.aspect_ratio ?? DEFAULT_ASPECT);
  return {
    model: (MODELS as readonly string[]).includes(model) ? (model as ModuleConfig["model"]) : DEFAULT_MODEL,
    resolution: (RESOLUTIONS as readonly string[]).includes(res) ? (res as ModuleConfig["resolution"]) : DEFAULT_RESOLUTION,
    aspect_ratio: (ASPECT_RATIOS as readonly string[]).includes(ar) ? (ar as ModuleConfig["aspect_ratio"]) : DEFAULT_ASPECT,
    camera_fixed: raw.camera_fixed === true,
    generate_audio: raw.generate_audio !== false,
    seed: typeof raw.seed === "number" ? raw.seed : -1,
  };
}

export function buildParams(input: MotionBackendInput, config: ModuleConfig): Record<string, unknown> {
  return {
    image: input.keyframe_url,
    prompt: input.prompt,
    aspect_ratio: config.aspect_ratio,
    duration: clampDuration(input.seconds),
    resolution: config.resolution,
    fps: OUT_FPS,
    camera_fixed: config.camera_fixed,
    watermark: false,
    generate_audio: config.generate_audio,
    seed: config.seed,
    use_virtual_avatar: true,
  };
}

// Override MODEL at call site: index uses config.model via buildParams only; AI.run needs the model id.
// Export helper so index can pass the selected model.
export function selectedModel(config: ModuleConfig): string {
  return config.model;
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
  return `cf-seedance/${jobId}.state.json`;
}
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_cf-seedance.mp4`;
}
