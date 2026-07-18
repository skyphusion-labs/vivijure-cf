// Vendored subset of the Vivijure module contract (vivijure-module/2) for the image-generate
// module. Matches src/modules/types.ts in vivijure-core for the shapes used here. Dependency-free,
// which is the point: a module must be buildable and deployable without the core package.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "image.generate" | "cast.image" | "keyframe" | "motion.backend" | "finish" | "score" | "plan.enhance";

export type ConfigField =
  | { type: "int" | "float"; default: number; min?: number; max?: number; label?: string; enum_labels?: Record<string, string> }
  | { type: "bool"; default: boolean; label?: string }
  | { type: "enum"; values: string[]; default: string; label?: string }
  | { type: "string"; default: string; label?: string };

export interface ModuleManifest {
  name: string;
  version: string;
  api: typeof MODULE_API;
  hooks: HookName[];
  provides?: Array<{ id: string; label: string }>;
  config_schema?: Record<string, ConfigField>;
  ui?: { section?: string; order?: number; locality?: "cloud" | "byo" | "local" };
}

export interface InvokeRequest<I = unknown> {
  hook: HookName;
  input: I;
  config: Record<string, unknown>;
  context?: { project?: string; job_id?: string };
}

export type InvokeResponse<O = unknown> =
  | { ok: true; output: O }
  | { ok: true; pending: true; poll: string }
  | { ok: false; error: string };

/** The image.generate input: a prompt and the knobs a text-to-image model takes. */
export interface ImageGenerateInput {
  prompt: string;
  negative_prompt?: string;
  /** Reference images as data: URLs, for multi-reference models. */
  refs?: string[];
  width?: number;
  height?: number;
}

/** The image.generate output: THE BYTES, not a storage key.
 *
 *  The core owns persistence. This module deliberately holds no bucket binding, so it cannot write
 *  an artifact into a namespace the studio's serve route does not read -- which is exactly the
 *  production defect (vivijure-cf#140) that shaped this contract. Do not "improve" this into
 *  returning a key. */
export interface ImageGenerateOutput {
  image: { bytes_b64: string; mime: string };
}
