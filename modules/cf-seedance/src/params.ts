// Pure helpers for cf-seedance: ByteDance Seedance via CF AI Gateway.
// RunPod Seedance V1.5 Pro (modules/seedance) was retired in cf#1075.
// Four published input schemas, vendored under ../schemas/ from
// https://developers.cloudflare.com/ai/models/bytedance/<id>/schema-input.json
// The manifest enum is the union. The body is the selected model's schema.
// use_virtual_avatar: ByteDance blocks faces as "real person" (7003 PrivacyInformation)
// unless this flag routes the still through their virtual-avatar library. Our keyframes
// are always synthetic.

import type { MotionBackendInput } from "./contract";
import schema25 from "../schemas/seedance-2.5.schema-input.json";
import schema20 from "../schemas/seedance-2.0.schema-input.json";
import schemaFast from "../schemas/seedance-2.0-fast.schema-input.json";
import schemaMini from "../schemas/seedance-2.0-mini.schema-input.json";

type SchemaBranch = {
  type?: string;
  const?: number | string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
};

type SchemaProp = SchemaBranch & {
  description?: string;
  default?: string | number | boolean;
  maxLength?: number;
  maxItems?: number;
  anyOf?: SchemaBranch[];
};

export type InputSchema = {
  properties: Record<string, SchemaProp>;
  required?: string[];
  additionalProperties?: boolean;
};

export const MODELS = [
  "bytedance/seedance-2.5",
  "bytedance/seedance-2.0",
  "bytedance/seedance-2.0-fast",
  "bytedance/seedance-2.0-mini",
] as const;
export const DEFAULT_MODEL = "bytedance/seedance-2.5";
/** MODEL is the default; runtime uses config.model. Kept for tag parity with other modules. */
export const MODEL = DEFAULT_MODEL;
export const OUT_FPS = 24;

type ModelId = (typeof MODELS)[number];

const SCHEMAS: Record<ModelId, InputSchema> = {
  "bytedance/seedance-2.5": schema25 as InputSchema,
  "bytedance/seedance-2.0": schema20 as InputSchema,
  "bytedance/seedance-2.0-fast": schemaFast as InputSchema,
  "bytedance/seedance-2.0-mini": schemaMini as InputSchema,
};

export function inputSchema(model: string): InputSchema {
  if ((MODELS as readonly string[]).includes(model)) return SCHEMAS[model as ModelId];
  throw new Error("cf-seedance: no published schema for model " + model);
}

function durationBounds(schema: InputSchema): { min: number; max: number } {
  const d = schema.properties.duration;
  if (!d) throw new Error("cf-seedance schema has no duration");
  if (typeof d.minimum === "number" && typeof d.maximum === "number") {
    return { min: d.minimum, max: d.maximum };
  }
  const ranged = (d.anyOf ?? []).filter((b) => typeof b.minimum === "number" && typeof b.maximum === "number");
  if (ranged.length !== 1) throw new Error("cf-seedance duration bounds are not a single published range");
  return { min: ranged[0].minimum as number, max: ranged[0].maximum as number };
}

/** Tightest published band. An id we do not know must not inherit 2.5's 30s. */
function tightestDuration(): { min: number; max: number } {
  const all = MODELS.map((m) => durationBounds(SCHEMAS[m]));
  return {
    min: Math.max(...all.map((b) => b.min)),
    max: Math.min(...all.map((b) => b.max)),
  };
}

export const MIN_DURATION = durationBounds(SCHEMAS[DEFAULT_MODEL]).min;
/** 2.0 family cap. Fast and Mini publish the same maximum. */
export const MAX_DURATION = durationBounds(SCHEMAS["bytedance/seedance-2.0"]).max;
export const MAX_DURATION_25 = durationBounds(SCHEMAS["bytedance/seedance-2.5"]).max;

// UI union. 1080p, 4k, and 9:21 are legal on some models and rejected on others.
// buildParams narrows to the selected schema. cf#932: one enum cannot depend on another field.
export const RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;
export const DEFAULT_RESOLUTION = "720p";
export const ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "9:21"] as const;
export const DEFAULT_ASPECT = "16:9";

const VOICE_LOCK_LINE = "Same speaking voice as the reference video. Do not invent a new speaker.";

export type ModuleConfig = {
  model: ModelId;
  resolution: (typeof RESOLUTIONS)[number];
  aspect_ratio: (typeof ASPECT_RATIOS)[number];
  camera_fixed: boolean;
  generate_audio: boolean;
  seed: number;
};

export type RunState =
  | { status: "running"; started_at: number; project: string; shot_id: string; seconds: number; workflow_id?: string }
  | { status: "done"; project: string; shot_id: string; seconds: number; clip_key: string; has_audio?: boolean }
  | { status: "failed"; error: string };

export interface PollToken { job_id: string; }

export function clampDuration(seconds: number, model: string = DEFAULT_MODEL): number {
  const n = Math.round(Number(seconds) || 5);
  const bounds = (MODELS as readonly string[]).includes(model)
    ? durationBounds(inputSchema(model))
    : tightestDuration();
  return Math.max(bounds.min, Math.min(bounds.max, n));
}

export function normalizeConfig(raw: Record<string, unknown>): ModuleConfig {
  const model = String(raw.model ?? DEFAULT_MODEL);
  const res = String(raw.resolution ?? DEFAULT_RESOLUTION);
  const ar = String(raw.aspect_ratio ?? DEFAULT_ASPECT);
  return {
    model: (MODELS as readonly string[]).includes(model) ? (model as ModuleConfig["model"]) : DEFAULT_MODEL,
    resolution: (RESOLUTIONS as readonly string[]).includes(res) ? (res as ModuleConfig["resolution"]) : DEFAULT_RESOLUTION,
    aspect_ratio: (ASPECT_RATIOS as readonly string[]).includes(ar) ? (ar as ModuleConfig["aspect_ratio"]) : DEFAULT_ASPECT,
    camera_fixed: raw.camera_fixed === true,
    generate_audio: raw.generate_audio !== false,
    seed: typeof raw.seed === "number" ? raw.seed : -1,
  };
}

function stringEnum(schema: InputSchema, field: string): readonly string[] {
  const values = schema.properties[field]?.enum;
  if (!values || values.length === 0) throw new Error("cf-seedance schema " + field + " has no enum");
  return values;
}

/** Requested value, else the schema's own default, else the first published value. */
function pickEnum(schema: InputSchema, field: string, requested: string): string {
  const allowed = stringEnum(schema, field);
  if (allowed.includes(requested)) return requested;
  const published = schema.properties[field]?.default;
  if (typeof published === "string" && allowed.includes(published)) return published;
  return allowed[0];
}

function firstLastForcesAdaptive(schema: InputSchema): boolean {
  const prop = schema.properties.aspect_ratio;
  const desc = prop?.description ?? "";
  return (prop?.enum ?? []).includes("adaptive")
    && desc.includes("First/last-frame")
    && desc.includes('"adaptive"');
}

function composePrompt(base: string, voice: boolean, maxLength: number | undefined): string {
  const extra = voice ? " " + VOICE_LOCK_LINE : "";
  const cap = typeof maxLength === "number" ? maxLength : base.length + extra.length;
  const room = Math.max(0, cap - extra.length);
  const head = base.length > room ? base.slice(0, room).trimEnd() : base;
  const out = (head + extra).trim();
  return out.length > cap ? out.slice(0, cap) : out;
}

export function buildParams(input: MotionBackendInput, config: ModuleConfig): Record<string, unknown> {
  const schema = inputSchema(config.model);
  const props = schema.properties;
  const params: Record<string, unknown> = {};
  const voice = Boolean(input.voice_ref_url);
  const hasLast = Boolean(input.last_keyframe_url);

  if (props.prompt) params.prompt = composePrompt(input.prompt, voice, props.prompt.maxLength);
  if (props.image) params.image = input.keyframe_url;
  if (hasLast && props.last_frame_image) params.last_frame_image = input.last_keyframe_url;

  if (props.aspect_ratio) {
    params.aspect_ratio = hasLast && firstLastForcesAdaptive(schema)
      ? "adaptive"
      : pickEnum(schema, "aspect_ratio", config.aspect_ratio);
  }
  if (props.duration) params.duration = clampDuration(input.seconds, config.model);
  if (props.resolution) params.resolution = pickEnum(schema, "resolution", config.resolution);
  if (props.fps) params.fps = typeof props.fps.const === "number" ? props.fps.const : OUT_FPS;
  if (props.camera_fixed) params.camera_fixed = config.camera_fixed;
  if (props.watermark) params.watermark = false;
  if (props.generate_audio) params.generate_audio = config.generate_audio;
  if (props.seed) params.seed = Number.isInteger(config.seed) ? config.seed : Math.trunc(config.seed);
  if (props.use_virtual_avatar) params.use_virtual_avatar = true;
  // 2.5 requires output_format. The 2.0 family schemas do not declare it
  // (additionalProperties: false), so it is omitted there. Send the published default.
  if (props.output_format && typeof props.output_format.default === "string") {
    params.output_format = props.output_format.default;
  }

  // Voice lock is a video clip. 2.5 publishes reference_videos[] (and reference_audios[],
  // which we do not use: the sample is not an audio URI). The 2.0 family publishes
  // reference_video. Mini's reference_audio is background music, not this sample.
  if (input.voice_ref_url) {
    if (props.reference_videos?.type === "array") params.reference_videos = [input.voice_ref_url];
    else if (props.reference_video?.type === "string") params.reference_video = input.voice_ref_url;
  }
  return params;
}

export function selectedModel(config: ModuleConfig): string {
  return config.model;
}

export function parseVideoUrl(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.state === "string" && r.state.length > 0 && r.state !== "Completed") return null;
  if (typeof r.video === "string" && r.video.length > 0) return r.video;
  const inner = r.result;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const v = (inner as Record<string, unknown>).video;
    if (typeof v === "string" && v.length > 0) return v;
  }
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
      for (const x of Object.values(v as Record<string, unknown>)) {
        const hit = visit(x);
        if (hit) return hit;
      }
    }
    return null;
  };
  return visit(result) ?? firstHttp;
}

export function encodePoll(t: PollToken): string {
  return btoa(JSON.stringify(t));
}
export function decodePoll(token: string): PollToken | null {
  try {
    const o = JSON.parse(atob(token)) as PollToken;
    if (o && typeof o.job_id === "string" && o.job_id.length > 0) return { job_id: o.job_id };
  } catch { /* fall through */ }
  return null;
}

export function stateKey(jobId: string): string {
  return `cf-seedance/${jobId}.state.json`;
}
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_cf-seedance.mp4`;
}
