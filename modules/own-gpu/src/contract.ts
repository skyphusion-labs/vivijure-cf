// Vendored subset of the Vivijure module contract (vivijure-module/2) for the own-gpu module.
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
export interface ModuleUi { section?: string; icon?: string; order?: number; locality?: "local" | "byo" | "cloud"; cost?: string; blurb?: string; limits?: string[]; }

/**
 * cp#270: the TENANT's per-job R2 credential, as the invoke envelope carries it. Vendored to match
 * `@skyphusion-labs/vivijure-core` `modules/types.ts`, like every other shape in this file.
 *
 * All four fields are REQUIRED by the backend contract; a partial block FAILS the job rather than
 * degrading, which is why the producer omits the whole block when it cannot fill all four.
 */
export interface TenantR2Config {
  endpoint: string;
  access_key_id: string;
  secret_access_key: string;
  bucket: string;
}

export interface ModuleManifest {
  name: string;
  version: string;
  api: typeof MODULE_API;
  hooks: HookName[];
  provides?: Provides[];
  config_schema?: ConfigSchema;
  ui?: ModuleUi;
  /** cp#270: this module submits to an endpoint that may be POOLED across tenants, so the core
   *  attaches the tenant's per-job R2 credential to its invoke envelope. OPTIONAL/additive,
   *  mirrors the core module contract. */
  needs_tenant_r2?: boolean;
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
  /**
   * cp#270: the TENANT's per-job R2 credential, present only when this module's manifest declares
   * `needs_tenant_r2` and the host carries a full credential set.
   *
   * THE ONLY SECRET THIS ENVELOPE CARRIES. `context` remains secrets-free by construction -- this
   * is a SIBLING of it, not a member. A receiver must call `takeTenantR2(req)` at the parse
   * boundary, which reads and REMOVES it in one step so nothing downstream holds an object
   * containing it.
   *
   * Absent means ABSENT: the key is omitted, never null. The backend REFUSES an explicit null
   * rather than reading it as "use the environment".
   */
  r2?: TenantR2Config;
}

// A module may answer synchronously (output) or, for a long-running job, asynchronously: return
// pending + a poll token, and the caller drives /poll until it is done.
export type InvokeResponse<O = unknown> =
  | { ok: true; output: O }
  // jobId: optional/additive (#318, cf#289) -- the provider job id, so a caller can hold an id
  // RunPod cannot enumerate later. Already on the canonical core contract; no MODULE_API bump.
  | { ok: true; pending: true; poll: string; jobId?: string }
  | { ok: false; error: string };

export interface PollRequest {
  poll: string;
}
export type PollResponse<O = unknown> =
  | { ok: true; pending: true }
  | { ok: true; output: O }
  | { ok: false; error: string };

// motion.backend payloads (vivijure-module/2). keyframe_url is the presigned, fetchable URL of the
// start keyframe (for cloud backends that pull over the internet); keyframe_key is the underlying
// R2 key (an own-GPU backend that shares the bucket reads it directly).
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
