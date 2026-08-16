// Pure helpers for cf-flux-3-video: Black Forest Labs FLUX 3 Video via CF AI Gateway.
// Model: black-forest-labs/flux-3-video
// Modes: t2v | i2v | v2v. i2v uses keyframes[], not image (CF 7003:
// "Unsupported field passed: image. Invalid value at keyframes").
// Duration 5-20s; resolution hd (and fhd per catalog). generate_audio default off (core score/mux owns audio).

import type { MotionBackendInput } from "./contract";

export const MODEL = "black-forest-labs/flux-3-video";
export const OUT_FPS = 24;
export const MIN_DURATION = 5;
export const MAX_DURATION = 20;
export const RESOLUTIONS = ["hd", "fhd"] as const;
export const DEFAULT_RESOLUTION = "hd";

export type ModuleConfig = {
  resolution: (typeof RESOLUTIONS)[number];
  generate_audio: boolean;
};

export type RunState =
  | { status: "running"; started_at: number; project: string; shot_id: string; seconds: number; workflow_id?: string }
  | { status: "done"; project: string; shot_id: string; seconds: number; clip_key: string }
  | { status: "failed"; error: string };

export interface PollToken { job_id: string; }

/** Snap shot seconds into FLUX 3's allowed band. Prefer 5/10/15/20 when near those steps. */
export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds) || 5);
  const clamped = Math.max(MIN_DURATION, Math.min(MAX_DURATION, n));
  // Prefer documented step sizes when within 2s of a step.
  const steps = [5, 10, 15, 20];
  let best = clamped;
  let bestDiff = Infinity;
  for (const s of steps) {
    const d = Math.abs(s - clamped);
    if (d < bestDiff) {
      bestDiff = d;
      best = s;
    }
  }
  return bestDiff <= 2 ? best : clamped;
}

export function normalizeConfig(raw: Record<string, unknown>): ModuleConfig {
  const res = String(raw.resolution ?? DEFAULT_RESOLUTION);
  return {
    resolution: (RESOLUTIONS as readonly string[]).includes(res) ? (res as ModuleConfig["resolution"]) : DEFAULT_RESOLUTION,
    generate_audio: raw.generate_audio === true,
  };
}

export function buildParams(input: MotionBackendInput, config: ModuleConfig): Record<string, unknown> {
  return {
    mode: "i2v",
    prompt: input.prompt,
    // Ordered start frames. { url } still 7003'd. Catalog wants image URIs in keyframes[].
    keyframes: [input.keyframe_url],
    duration: clampDuration(input.seconds),
    resolution: config.resolution,
    generate_audio: config.generate_audio,
  };
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
  return `cf-flux-3-video/${jobId}.state.json`;
}
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_cf-flux-3-video.mp4`;
}
