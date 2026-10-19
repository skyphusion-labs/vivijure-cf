// Pure Wan 2.6 mapping/parsing: build the RunPod request body, parse the result video URL, and
// encode/decode the async poll token. No I/O here, so it unit-tests without the runtime or spend.
// The video-URL parse, poll token, and RunPod-GC helpers are shared, vendored per-module so the
// module stays independent (matches the seedance/hailuo reference).
//
// RunPod public endpoint wan-2-6-i2v: image + prompt + optional audio URL.
// enable_prompt_expansion defaults false so the prompt is sent as-is.

import type { MotionBackendInput } from "./contract";
import { mp4VideoTiming } from "../../_shared/mp4-timing";

// Wan 2.6 accepts ONLY a discrete duration enum {5, 10, 15} seconds -- NOT a continuous range.
// Submitting any other value (e.g. a 4s storyboard shot) 400s at the provider:
//   "field \"duration\" must be one of [5, 10, 15], got number 4".
// Snap UP to the smallest allowed value >= the per-shot seconds (never shorter than the shot, which
// would clip the dialogue); clamp to the longest allowed for anything beyond it. A 4s shot -> 5.
const WAN_DURATIONS = [5, 10, 15] as const;
export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds) || 5);
  return WAN_DURATIONS.find((d) => d >= n) ?? WAN_DURATIONS[WAN_DURATIONS.length - 1];
}

/** The RunPod /run body for Wan 2.6, mapped from the hook input + the clamped module config. */
export function buildWanBody(input: MotionBackendInput, cfg: Record<string, unknown>): {
  input: Record<string, unknown>;
} {
  const inputBody: Record<string, unknown> = {
    prompt: input.prompt,
    image: input.keyframe_url,
    negative_prompt: "",
    // cf#922: the key is `size`, and its VALUE SPACE IS NOT WHAT RUNPOD DOCUMENTS.
    //
    // This door hardcoded `resolution: "720p"`. Measured 2026-09-27 by direct submit: RunPod's worker
    // validates with a pydantic model that IGNORES extra fields, so `resolution` was silently dropped
    // and the vendor applied its own default. That is why the 1270x726 clip measured last sprint
    // looked right: it was the vendor default, never a configured outcome.
    //
    // RunPod's docs page for wan-2-6-i2v says `size` takes `1280*720` / `1920*1080`. THAT IS WRONG,
    // and following it would have broken every shot. The worker forwards our `size` value verbatim
    // into the VENDOR's `resolution` field, and submitting `size: "9999*9999"` returns the vendor's
    // own enum: `field "resolution" must be one of ["720p", "1080p"]`. So the accepted values are
    // `720p` and `1080p` (job sync-7334e207-526d-4c70-8ca4-ffcb3284687b-u2).
    //
    // The knob below is EARNED rather than assumed, which is the cf#935 test: `size: "1080p"` was
    // submitted and the DELIVERED artifact measured 1920x1080 at 30fps via ffprobe (job
    // sync-7eb360c7-9111-43da-91f8-8b2c80f5c72b-u1, cost $0.75). A non-default delivery is the
    // falsifiable positive, so unlike the infinitetalk knob this one demonstrably moves pixels.
    size: cfg.size === "1080p" ? "1080p" : "720p",
    duration: clampDuration(input.seconds),
    shot_type: "single",
    seed: -1,
    enable_prompt_expansion: cfg.enable_prompt_expansion === true,
    enable_safety_checker: cfg.enable_safety_checker === true,
  };
  // Driving audio is the shot LINE (WAV/MP3), never the Cast sample.
  if (typeof input.audio_url === "string" && input.audio_url) {
    inputBody.audio = input.audio_url;
  }
  return { input: inputBody };
}

/** RunPod video workers vary in output shape; find the first plausible video URL (prefers an .mp4). */
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

/** The R2 key the rendered clip is stored under, per shot. */
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_wan.mp4`;
}

// --- async poll token --------------------------------------------------------------------------

// Everything /poll needs to finalize a job: the RunPod job id + where the clip belongs + its length.
// The token is opaque (base64 JSON) so the caller just round-trips it from /invoke to /poll.
// submittedAt (epoch ms) lets the stateless /poll measure a grace window before treating a RunPod
// "job not found" as a real terminal GC vs a post-submit propagation race (issue #141).
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
  } catch {
    /* fall through */
  }
  return null;
}

// How long after submit a RunPod "job not found" is treated as a propagation race vs a real GC. Mirrors
// the control plane's PHANTOM_GRACE_SECONDS (150s) so a momentary post-submit 404 never false-fails.
export const RUNPOD_NOTFOUND_GRACE_MS = 150_000;

/** Pure: did RunPod report this job as gone? A GC'd job returns HTTP 404 with a body like
 *  {"status":404,"title":"Not Found",...} where `status` is the NUMBER 404, not a run state. (#141)
 *  This module DOWNLOADS the provider video then writes R2 itself only on COMPLETED, so a never-
 *  completed job has no recoverable artifact -- the only correct behavior past grace is to FAIL. */
export function runpodJobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false;
  if (typeof st === "number") return st === 404;
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

/** Pure: "gone-failed" past the grace window (or a legacy token); "gone-grace" inside it. (#141) */
export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed";
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}

// Cold-start cap: on a VIRGIN host the image pull (10-20GB) can outlive the normal #141 grace window
// while /status 404s, so the first-ever job on a fresh endpoint false-failed ("GC'd or never ran")
// and only the warm retry succeeded. When the endpoint's /health shows no worker has EVER come up,
// the 404 means "still initializing", not "dropped" -- keep polling up to this cap instead.
export const RUNPOD_COLD_GRACE_MS = 900_000; // 15 min; the film pipeline's 90-min deadline still bounds it

/** Pure: has NO worker ever come up on this endpoint (ready/idle/running all 0) while one is still
 *  coming (initializing/throttled > 0)? That is the virgin-host image pull. A dead endpoint (nothing
 *  up, nothing coming) returns false so a gone job still fails instead of pending forever. */
export function workersStillCold(health: unknown): boolean {
  if (!health || typeof health !== "object") return false;
  const w = (health as Record<string, unknown>).workers;
  if (!w || typeof w !== "object") return false;
  const n = (k: string): number => {
    const v = (w as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const up = n("ready") + n("idle") + n("running");
  const coming = n("initializing") + n("throttled");
  return up === 0 && coming > 0;
}

/** Pure: did the backend report a TERMINAL error inside `output` while the RunPod envelope status
 *  never advanced? (F17: a handler error path that returns instead of raising leaves the job
 *  IN_PROGRESS forever -- billing the worker -- while output already carries
 *  {status:"error", error:{stage, message}}.) Returns the human error string, or null when the
 *  output is a normal progress snapshot. */
export function terminalErrorInOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const err = o.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const msg = typeof e.message === "string" && e.message.length > 0
      ? e.message
      : JSON.stringify(e).slice(0, 200);
    const stage = typeof e.stage === "string" && e.stage.length > 0 ? " (stage: " + e.stage + ")" : "";
    return msg + stage;
  }
  if (typeof err === "string" && err.length > 0) return err;
  if (o.status === "error") return "backend reported status=error with no error detail";
  return null;
}

/** cf#923: the DELIVERED clip's rate and frame count, measured from the container.
 *
 *  Replaces `fps: OUT_FPS` plus a frames value computed from the request. A value computed from the
 *  request is not a measurement no matter what the field is named: this door reported 24fps against a
 *  delivered 25, and its sibling reported 24 against 30.
 *
 *  UNMEASURED IS REPORTED AS ZERO, never as a constant. Core's contract requires numeric fps/frames
 *  (conformance checks `isNum`, not `> 0`) and core only records a delivery when
 *  `output.fps > 0 && output.frames > 0` (render-orchestrator). So 0 is the contract's existing
 *  not-available channel: it passes conformance, the clip is still delivered, and nothing downstream
 *  records a rate nobody measured. */
export function deliveredTiming(bytes: ArrayBuffer): { fps: number; frames: number } {
  const t = mp4VideoTiming(new Uint8Array(bytes));
  if (!t || !(t.frames > 0)) return { fps: 0, frames: 0 };
  const fps = t.fps != null && t.fps > 0 ? Math.round(t.fps * 1000) / 1000 : 0;
  return { fps, frames: t.frames };
}
