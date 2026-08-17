// Vendored from src/modules/types.ts (vivijure-module/2). Copy only what this module needs so it
// stays independent of the core repo. Do not import from the core directly.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "motion.backend" | "finish" | "score" | "plan.enhance";

export type ConfigField =
  | { type: "int" | "float"; default: number; min?: number; max?: number; label?: string; enum_labels?: Record<string, string> }
  | { type: "bool"; default: boolean; label?: string }
  | { type: "enum"; values: string[]; default: string; label?: string }
  | { type: "string"; default: string; label?: string };

export type ConfigSchema = Record<string, ConfigField>;

export interface Provides { id: string; label: string; }
export interface ModuleUi { section?: string; icon?: string; order?: number; }

/** OPTIONAL, additive: this module's declared artifact conventions, read by the core's
 *  R2-authoritative finish recovery (see the core's src/modules/types.ts FinishArtifactsDecl). */
export interface FinishArtifactsDecl {
  output_key:
    | { kind: "shot_named"; filename: string }
    | { kind: "append_suffix"; suffix: string };
  applied?: Array<{ when?: { knob: string; equals: string | number | boolean }; tag: string }>;
}

export interface ModuleManifest {
  name: string;
  version: string;
  api: typeof MODULE_API;
  hooks: HookName[];
  provides?: Provides[];
  config_schema?: ConfigSchema;
  ui?: ModuleUi;
  finish_artifacts?: FinishArtifactsDecl;
  /** OPTIONAL, additive (cf#537). Whether this module runs when a render carries NO explicit
   *  selection for its hook. "default" or ABSENT = yes, the pre-cf#537 behaviour; "opt_in" = it runs
   *  ONLY when a caller NAMES it in that render's selection. The module declares its own nature; the
   *  participation policy lives in the core (selectForChain). Naming a module overrides this in the
   *  permissive direction and never in the restrictive one. See the core src/modules/types.ts for the
   *  full contract text, including why the permissive default is a stated limit rather than an
   *  oversight. */
  participation?: "default" | "opt_in";
  /** OPTIONAL, additive (core#182 / core#223). The door's enforced per-invocation wall-clock
   *  ceiling in seconds. This is the guard the door enforces, not an aspiration. If the door env
   *  overrides it, the number on the shipped MANIFEST is the SHIPPED default. See the core
   *  src/modules/types.ts for the full contract text. */
  max_invocation_seconds?: number;
}

export interface InvokeContext { project: string; job_id: string; }

export interface InvokeRequest<I = unknown> {
  hook: HookName;
  input: I;
  config: Record<string, unknown>;
  context: InvokeContext;
}

export type InvokeResponse<O = unknown> =
  | { ok: true; output: O }
  // jobId: optional/additive (#318, cf#289) -- the provider job id, so a caller can hold an id
  // RunPod cannot enumerate later. Already on the canonical core contract; no MODULE_API bump.
  | { ok: true; pending: true; poll: string; jobId?: string }
  | { ok: false; error: string };

export interface PollRequest { poll: string; }

export type PollResponse<O = unknown> =
  | { ok: true; pending: true }
  | { ok: true; output: O }
  | { ok: false; error: string };

export interface FinishInput {
  shot_id: string;
  clip_key: string;
  // Optional hints (#232): the GPU side ffprobes the clip when absent; these are used only for
  // output-metadata fallback (e.g. out_fps: input.src_fps). advanceFinishPhase sends only
  // { shot_id, clip_key, audio_key }, and the core FinishInput already declares
  // them optional -- so the producer's real shape now matches (no more `as FinishInput` cover).
  src_fps?: number;
  frames?: number;
  // SOURCE dimensions: what this clip ACTUALLY IS, measured by the core from the mp4 tkhd box.
  // Absence is meaningful and honest -- the backend probes the clip -- so a miss does NOT render as
  // a value.
  width?: number;
  height?: number;
  // cf#507b THE DELIVERY TARGET: what the FILM SHIPS AT. A DECISION, named apart from width/height
  // rather than overloading them, because those are a measurement of the footage and conflating the
  // two would make the upscale aim at its own input size and do nothing.
  //
  // Mirrors vivijure-core's FinishInput (core >= 1.11.0). This contract is VENDORED rather than
  // imported ("Copy only what this module needs so it stays independent of the core repo"), so a
  // field the core adds does not arrive here on a dependency bump -- it has to be mirrored, and
  // that is why this module could not see a target the core was already sending.
  delivery_width?: number;
  delivery_height?: number;
  // #583 provenance: the core-computed param-hash of this step's inputs, forwarded VERBATIM into the
  // RunPod job so the container stamps `<output_key>.hash` after the artifact. Opaque here -- never
  // parse/recompute it. Absent from a legacy core => the container writes no sidecar (safe re-run).
  output_hash?: string;
  // cf#312 credentialless satellite transport (additive). Core presigns when it can; absent => R2 mode.
  video_url?: string;
  output_url?: string;
  output_key?: string;
  audio_url?: string;
  hash_url?: string;
}

export interface FinishOutput {
  shot_id: string;
  clip_key: string;
  out_fps: number;
  frames: number;
  applied: string[];   // ["upscale:2x", ...] on success; ["passthrough:<reason>"] / ["noop:nothing-enabled"] otherwise
  degraded?: string;   // reason, set ONLY on a real passthrough degrade (never on success or the no-op); see #77
}
