// Vendored subset of the Vivijure module contract (vivijure-module/2) for the music-gen module.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "score";

export type ConfigField =
  | { type: "int" | "float"; default: number; min?: number; max?: number; label?: string; enum_labels?: Record<string, string> }
  | { type: "bool"; default: boolean; label?: string }
  | { type: "enum"; values: string[]; default: string; label?: string }
  | { type: "string"; default: string; label?: string };
export type ConfigSchema = Record<string, ConfigField>;

export interface Provides { id: string; label: string; }
export interface ModuleUi { section?: string; icon?: string; order?: number; }
export interface ModuleManifest {
  name: string;
  version: string;
  api: typeof MODULE_API;
  hooks: HookName[];
  provides?: Provides[];
  config_schema?: ConfigSchema;
  ui?: ModuleUi;
}

export interface InvokeContext { project: string; job_id: string; }
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

export type InvokeResponse<O = unknown> =
  | { ok: true; output: O }
  | { ok: true; pending: true; poll: string }
  | { ok: false; error: string; reason?: InvokeFailureReason };
export interface PollRequest { poll: string; }
// pending may carry submitted_at (epoch ms) + elapsed_ms so a caller can enforce a timeout without
// inventing a wall-clock impression (#391). Both are optional for older callers / legacy tokens.
export type PollResponse<O = unknown> =
  | { ok: true; pending: true; submitted_at?: number; elapsed_ms?: number }
  | { ok: true; output: O }
  | { ok: false; error: string };

export interface PlanEnhanceScene {
  prompt: string;
  [k: string]: unknown;
}
export interface PlanEnhanceStoryboard {
  scenes: PlanEnhanceScene[];
  [k: string]: unknown;
}

export interface ScoreInput {
  film_key: string;
  seconds: number;
  storyboard?: PlanEnhanceStoryboard;
}

export interface ScoreOutput {
  film_key: string;
  applied: string[];
  // The shared chain degrade convention (S4 consistency pass): set ONLY when the module could not
  // do what was asked and passed through / partially applied, carrying the reason. Never silent.
  degraded?: string;
}
