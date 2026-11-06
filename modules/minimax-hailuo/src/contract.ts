// Vendored subset of the Vivijure module contract (vivijure-module/2) for the minimax-hailuo module.
// Matches src/modules/types.ts for the shapes used here. Dependency-free.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "motion.backend" | "finish" | "score" | "plan.enhance";

export type ConfigField =
  | { type: "int" | "float"; default: number; min?: number; max?: number; label?: string; enum_labels?: Record<string, string> }
  | { type: "bool"; default: boolean; label?: string }
  | { type: "enum"; values: string[]; default: string; label?: string }
  | { type: "string"; default: string; label?: string };

export type ConfigSchema = Record<string, ConfigField>;

export interface Provides { id: string; label: string; }
export interface ModuleUi {
  section?: string;
  icon?: string;
  order?: number;
  locality?: "local" | "byo" | "cloud";
  cost?: string;
  blurb?: string;
  limits?: string[];
  /** Lowest and highest clip rate in USD per second, at provider cost with no markup (cf#1246). */
  cost_usd_per_second?: [number, number];
  /** Price points for a door billed per clip, at provider cost (cf#1246). An absent key matches any value. */
  cost_usd_per_clip?: ClipPrice[];
  /** The day the cost above was read, YYYY-MM-DD (cf#1246). Required with either cost field. */
  cost_as_of?: string;
}

/** How we actually call this motion door (same shape as core MotionUsageDecl). */
export type MotionVoiceMode = "prompt_lock" | "seed_and_prompt" | "cast_tts" | "prev_clip";
export interface MotionUsageDecl {
  native_audio: boolean;
  voice: MotionVoiceMode;
  scatter_native_audio: boolean;
  min_seconds: number;
  max_seconds: number;
  duration_steps?: number[];
  first_last?: boolean;
  seed?: boolean;
  /** cf#1246: the face grade the panel reads instead of naming doors. */
  face_hold?: FaceHold;
}

export interface ModuleManifest {
  name: string;
  version: string;
  api: typeof MODULE_API;
  hooks: HookName[];
  provides?: Provides[];
  config_schema?: ConfigSchema;
  ui?: ModuleUi;
  usage?: MotionUsageDecl;
}

export interface InvokeContext {
  project: string;
  job_id: string;
}

export interface InvokeRequest<I = unknown> {
  hook: HookName;
  input: I;
  config: Record<string, unknown>;
  context: InvokeContext;
}

/** VENDORED from core's `InvokeFailureReason` (vivijure-module/2, core#291). CLOSED set.
 *
 *  DO NOT HAND-EDIT. `tests/invoke-failure-reason-vendored.test.ts` derives this block from core's
 *  `INVOKE_FAILURE_REASONS` and fails if any of the 34 vendored copies drifts from it. Copied rather
 *  than imported because this file is deliberately import-free (a module must build without the core
 *  package); the test is what makes 34 copies safe.
 *
 *  ABSENT means the module has not adopted the field. It is never defaulted to a class. */
export type InvokeFailureReason =
  | "bad-input"
  | "unsupported"
  | "not-configured"
  | "unauthorized"
  | "quota-exceeded"
  | "rate-limited"
  | "upstream-unavailable"
  | "backend-error"
  | "cancelled"
  | "timeout"
  | "internal";

// A module may answer synchronously (output) or, for a long-running job, asynchronously: return
// pending + a poll token, and the caller drives /poll until it is done.
export type InvokeResponse<O = unknown> =
  | { ok: true; output: O }
  // jobId: optional/additive (#318, cf#289) -- the RunPod job id, so a caller can hold an id
  // RunPod cannot enumerate later. Already on the canonical core contract; no MODULE_API bump.
  | { ok: true; pending: true; poll: string; jobId?: string }
  | { ok: false; error: string; reason?: InvokeFailureReason };

export interface PollRequest {
  poll: string;
}
export type PollResponse<O = unknown> =
  | { ok: true; pending: true }
  | { ok: true; output: O }
  | { ok: false; error: string };

// motion.backend payloads (vivijure-module/2). keyframe_url is the presigned, fetchable URL of the
// start keyframe (the core presigns the private R2 object so a cloud backend can pull it).
export interface MotionBackendInput {
  shot_id: string;
  keyframe_url: string;
  keyframe_key?: string;
  prompt: string;
  seconds: number;
}
export interface MotionBackendOutput {
  shot_id: string;
  clip_key: string;
  fps: number;
  frames: number;
}

/** One per-clip price point (cf#1246). `resolution` is a value of the door's resolution enum and `seconds` one of
 *  its duration steps; an absent key matches any value. */
export interface ClipPrice { usd: number; resolution?: string; seconds?: number; }

/** How well the door holds a face across a film (cf#1246): hold = the same face throughout, two = pinned by the
 *  first and last stills, one = pinned by the start still only, drift = faces drift. */
export type FaceHold = "hold" | "two" | "one" | "drift";
