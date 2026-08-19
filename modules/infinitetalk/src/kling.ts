// InfiniteTalk on RunPod: portrait + our audio. Speaker is Cast TTS, not invented.

import type { MotionBackendInput } from "./contract";

export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds) || 5);
  return Math.max(2, Math.min(15, n));
}

function audioUrl(input: MotionBackendInput, cfg: Record<string, unknown>): string {
  if (typeof input.audio_url === "string" && input.audio_url) return input.audio_url;
  if (typeof cfg.audio_url === "string" && cfg.audio_url) return cfg.audio_url;
  return "";
}

export function buildKlingBody(input: MotionBackendInput, cfg: Record<string, unknown>): {
  input: Record<string, unknown>;
} {
  const size = cfg.size === "720p" ? "720p" : "480p";
  return {
    input: {
      prompt: input.prompt,
      image: input.keyframe_url,
      audio: audioUrl(input, cfg),
      size,
      enable_safety_checker: cfg.enable_safety_checker === true,
    },
  };
}

export function extractVideoUrl(output: unknown): string | null {
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
      const o = v as Record<string, unknown>;
      for (const k of ["video_url", "videoUrl", "url", "video", "output", "result", "assets"]) {
        if (k in o) { const hit = visit(o[k]); if (hit) return hit; }
      }
      for (const x of Object.values(o)) { const hit = visit(x); if (hit) return hit; }
    }
    return null;
  };
  return visit(output) ?? firstHttp;
}

export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_infinitetalk.mp4`;
}

export interface PollState {
  jobId: string;
  project: string;
  shotId: string;
  seconds: number;
  submittedAt?: number;
}

export function encodePoll(s: PollState): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): PollState | null {
  try {
    const o = JSON.parse(atob(token)) as PollState;
    if (o && typeof o.jobId === "string" && typeof o.project === "string" && typeof o.shotId === "string") {
      return {
        jobId: o.jobId, project: o.project, shotId: o.shotId, seconds: Number(o.seconds) || 5,
        submittedAt: typeof o.submittedAt === "number" ? o.submittedAt : undefined,
      };
    }
  } catch { /* fall through */ }
  return null;
}

export const RUNPOD_NOTFOUND_GRACE_MS = 150_000;
export function runpodJobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false;
  if (typeof st === "number") return st === 404;
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}
export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed";
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}
export const RUNPOD_COLD_GRACE_MS = 900_000;
export function workersStillCold(health: unknown): boolean {
  if (!health || typeof health !== "object") return false;
  const w = (health as Record<string, unknown>).workers;
  if (!w || typeof w !== "object") return false;
  const n = (k: string): number => {
    const v = (w as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  return n("ready") + n("idle") + n("running") === 0 && n("initializing") + n("throttled") > 0;
}
export function terminalErrorInOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const err = o.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const msg = typeof e.message === "string" && e.message.length > 0 ? e.message : JSON.stringify(e).slice(0, 200);
    const stage = typeof e.stage === "string" && e.stage.length > 0 ? " (stage: " + e.stage + ")" : "";
    return msg + stage;
  }
  if (typeof err === "string" && err.length > 0) return err;
  if (o.status === "error") return "backend reported status=error with no error detail";
  return null;
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

/** Delivered mp4 duration from mvhd. Null when the file is not inspectable. */
export function mp4DurationSeconds(bytes: Uint8Array): number | null {
  const walk = (start: number, end: number): number | null => {
    let o = start;
    while (o + 8 <= end) {
      let size = u32be(bytes, o);
      const type = fourcc(bytes, o + 4);
      let header = 8;
      if (size === 1) {
        if (o + 16 > end) break;
        size = u32be(bytes, o + 12);
        header = 16;
      }
      if (size === 0) size = end - o;
      if (size < header) break;
      const boxEnd = Math.min(o + size, end);
      if (type === "mvhd") {
        const p = o + header;
        if (p + 20 > boxEnd) return null;
        const version = bytes[p];
        let ts: number;
        let dur: number;
        if (version === 1) {
          if (p + 32 > boxEnd) return null;
          ts = u32be(bytes, p + 20);
          dur = u32be(bytes, p + 28);
        } else {
          ts = u32be(bytes, p + 12);
          dur = u32be(bytes, p + 16);
        }
        return ts > 0 ? dur / ts : null;
      }
      if (MP4_CONTAINERS.has(type)) {
        const hit = walk(o + header, boxEnd);
        if (hit != null) return hit;
      }
      o = boxEnd;
    }
    return null;
  };
  return walk(0, bytes.length);
}

/** Poll frames = delivered mp4 duration * fps when inspectable, else round(wavSeconds * fps). */
export function framesFromDelivered(bytes: ArrayBuffer, wavSeconds: number, fps: number): number {
  const d = mp4DurationSeconds(new Uint8Array(bytes));
  if (d && d > 0) return Math.max(1, Math.round(d * fps));
  const fallback = Number.isFinite(wavSeconds) && wavSeconds > 0 ? wavSeconds : 0;
  return Math.max(1, Math.round(fallback * fps));
}
