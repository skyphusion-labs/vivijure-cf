// Vendored subset of the Vivijure module contract (vivijure-module/2).
// Matches src/modules/types.ts for the shapes used here. Dependency-free.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "motion.backend";

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

export type InvokeResponse<O = unknown> =
  | { ok: true; output: O }
  | { ok: true; pending: true; poll: string; jobId?: string }
  | { ok: false; error: string };

export interface PollRequest {
  poll: string;
}
export type PollResponse<O = unknown> =
  | { ok: true; pending: true }
  | { ok: true; output: O }
  | { ok: false; error: string };

export interface MotionBackendInput {
  shot_id: string;
  keyframe_url: string;
  last_keyframe_url?: string;
  last_keyframe_key?: string;
  keyframe_key?: string;
  prompt: string;
  seconds: number;
  /** Kept Cast talking sample. Alibaba driving_audio (wav/mp3); we send the URL and see if CF forwards it. */
  voice_ref_url?: string;
}
export interface MotionBackendOutput {
  shot_id: string;
  clip_key: string;
  fps: number;
  frames: number;
}
