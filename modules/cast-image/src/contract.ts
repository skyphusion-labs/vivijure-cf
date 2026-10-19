// Vendored subset of the Vivijure module contract (vivijure-module/2) for the cast-image module.
// Matches src/modules/types.ts for the shapes used here. Dependency-free.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "cast.image" | "keyframe" | "motion.backend" | "finish" | "score" | "plan.enhance";

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
export type PollResponse<O = unknown> =
  // progress + images are ADDITIVE (cf#386): optional so a legacy poll shape still parses.
  // When set, done/total/images report generation progress so the host can advance `registered`
  // while the job runs instead of only at the terminal batch.
  | { ok: true; pending: true; progress?: { done: number; total: number }; images?: { key: string; mime: string }[] }
  | { ok: true; output: O }
  | { ok: false; error: string };

// cast.image payloads (vivijure-module/2). portrait_url / source_urls are presigned, fetchable URLs
// (the core presigns the private R2 objects so the image model can pull them).
export interface CastImageInput {
  cast_id: number;
  portrait_url: string;
  portrait_key?: string;
  source_urls?: string[];
  bible?: string;
  art_style?: string;
}
export interface CastImageOutput {
  cast_id: number;
  images: { key: string; mime: string }[];
  applied: string[];
}
