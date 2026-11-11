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

/**
 * cf#932: Veo 3.1 makes 1080p only as an 8 second clip. Google's reference lists `resolution` as
 * `"1080p"` (only supports 8s duration) and `durationSeconds` as must be "8" with 1080p, for every
 * Veo 3.1 variant (https://ai.google.dev/gemini-api/docs/veo, read 2026-11-09). Cloudflare's
 * schema-input.json for google/veo-3.1-fast lists the two enums independently and says nothing
 * either way, and whether its wrapper enforces the rule is not measured.
 *
 * `config_schema` cannot state that one field limits another, so the panel offers 1080p on any shot.
 * This is the module refusing the pair itself, before the provider is called, so the shot fails with
 * a reason a person can act on rather than a provider error or a clip that is not what was asked.
 * Returns the error, or null when the pair is allowed. `seconds` is the SNAPPED duration (4, 6 or 8).
 */
export function resolutionDurationError(config: ModuleConfig, seconds: number): string | null {
  if (config.resolution !== "1080p" || seconds === 8) return null;
  return "cf-veo: 1080p needs an 8 second clip, and this shot is " + seconds + "s. "
    + "Veo 3.1 makes 1080p at 8 seconds only. Use 720p, or make the shot 8 seconds long.";
}

export function normalizeConfig(raw: Record<string, unknown>): ModuleConfig {
  const ar = raw.aspect_ratio;
  return {
    generate_audio: raw.generate_audio !== false,
    aspect_ratio: ar === "9:16" || ar === "1:1" ? ar : "16:9",
    resolution: raw.resolution === "1080p" ? "1080p" : "720p",
  };
}

/** bytes -> base64, chunked so a large keyframe does not blow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Read the keyframe and return it as the model's image_input: bare base64, with no data: prefix.
 *
 * Measured from the AI Gateway logs, 2026-10-30. A presigned URL failed with 2002. A data URI failed
 * with the provider's own words, "Invalid base64 encoded bytes", because the provider decodes the whole
 * string. Failed attempts cost 0.
 */
export async function keyframeImageInput(
  url: string,
  fetcher: (u: string) => Promise<Response> = (u) => fetch(u),
): Promise<string> {
  const resp = await fetcher(url);
  // The URL is presigned, so the message carries the status and never the URL.
  if (!resp.ok) throw new Error("keyframe fetch " + resp.status);
  return bytesToBase64(new Uint8Array(await resp.arrayBuffer()));
}

export function buildParams(
  input: MotionBackendInput,
  config: ModuleConfig,
  imageInput: string,
): Record<string, unknown> {
  return {
    prompt: input.prompt,
    image_input: imageInput,
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
