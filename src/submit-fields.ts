// cf#896: a submit door refuses a field it does not read, and a quality tier it does not know.
//
// THE FAILURE THIS CLOSES. `readBody` is a cast, so every submit door accepted any JSON object and
// read only the fields it knew. A caller that sent `quality_tier: "draft"` (the door reads
// `qualityTier`) or a top-level `resolution: "480p"` (no door reads it; it belongs in the motion
// config) got a 201 and a render at `final` and at the motion door's default size. Nothing in the
// record showed the difference. A misspelt field is now a 400 that names it, before any spend.
//
// THE LISTS ARE EXACT. Each one is the set of fields its handler reads, and studio.ts holds each list
// equal to its handler's body type at compile time, so a field added to a handler and not to its
// list (or the reverse) is a type error. Two documented aliases stay accepted and ignored on purpose:
// `shardCount` / `shard_count` (CONTRACT 2.23, film scatter is retired).
//
// SPELLINGS A SHIPPED CLIENT SENDS ARE ACCEPTED, NOT REFUSED. The iOS client (vivijure-ios
// StoryboardRenderRequest) sends each panel field in two spellings, camelCase and snake_case, plus the
// board it derived `scenes` from and a top-level `keyframe_backend`. A snake_case alias of a field the
// door reads is RENAMED to that field before the handler sees it, so its value is applied rather than
// dropped. If both spellings arrive with different values the request is refused, because there is no
// right one to pick. `keyframe_backend` moves into `renderOverrides.keyframe_backend`, which is where
// the panel doors read it. `storyboard` is accepted and ignored: the door reads `scenes` and the
// bundle, and the board is the source the client built `scenes` from.
//
// EXTERNAL REQUESTS ONLY. The check runs in the route table, not in the handler, for the same reason
// refusingLongFilmProjects does: a retry replays a stored body through the handler (and adds
// `reuse_finished`), and a long film starts its parts by calling the film handler directly. Those
// bodies were built by this studio and already passed this door.

import { QUALITY_TIERS } from "@skyphusion-labs/vivijure-core/render-module-config";

/** POST /api/storyboard/render. */
export const PANEL_RENDER_FIELDS = [
  "project", "bundleKey", "qualityTier", "renderOverrides", "keyframesOnly", "audioKey",
  "processShotIds", "projectId", "scenes", "motion_backend", "castLoras", "film_titles",
  "style_prefix", "voice_lock", "shardCount", "shard_count", "idempotency_key", "idempotencyKey",
] as const;

/** POST /api/storyboard/render-from-keyframes. */
export const FROM_KEYFRAMES_FIELDS = [
  "project", "bundleKey", "qualityTier", "renderOverrides", "audioKey", "projectId",
  "motion_backend", "castLoras", "idempotency_key", "idempotencyKey",
] as const;

/** POST /api/render/film. */
export const FILM_SUBMIT_FIELDS = [
  "project", "bundle_key", "scenes", "motion_backend", "keyframe_backend", "keyframe_config",
  "motion_config", "finish_config", "finish_select", "speech_config", "film_finish_config",
  "master_config", "audio_key", "film_titles", "dialogue_lines", "cast_loras", "qualityTier",
  "shard_count", "shardCount", "delivery_width", "delivery_height", "delivery_fps", "reuse_finished",
  "idempotency_key", "idempotencyKey", "projectId",
] as const;

/** Snake_case spellings of panel fields, as the iOS client sends them, and the field each one is. */
export const PANEL_RENDER_ALIASES: Readonly<Record<string, (typeof PANEL_RENDER_FIELDS)[number]>> = {
  bundle_key: "bundleKey",
  quality_tier: "qualityTier",
  project_id: "projectId",
  cast_loras: "castLoras",
  keyframes_only: "keyframesOnly",
};
/** The same spellings on render-from-keyframes, which has no keyframes-only mode. */
export const FROM_KEYFRAMES_ALIASES: Readonly<Record<string, (typeof FROM_KEYFRAMES_FIELDS)[number]>> = {
  bundle_key: "bundleKey",
  quality_tier: "qualityTier",
  project_id: "projectId",
  cast_loras: "castLoras",
};
/** Fields the panel doors accept and do not read. Documented in CONTRACT 2.18. */
export const PANEL_IGNORED_FIELDS = ["storyboard"] as const;

/** How one door treats a body before its handler runs. */
export interface SubmitDoorRules {
  door: string;
  fields: readonly string[];
  aliases?: Readonly<Record<string, string>>;
  ignored?: readonly string[];
  /** A top-level keyframe_backend moves into renderOverrides.keyframe_backend. */
  keyframeBackendIntoOverrides?: boolean;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Rename aliases to the field the door reads, and move keyframe_backend into renderOverrides.
 *  Returns the body to hand the handler, or a refusal when two spellings disagree. A body that is not a
 *  JSON object is returned unchanged, for the handler to answer. */
export function normalizeSubmitBody(
  body: unknown,
  rules: SubmitDoorRules,
): { body: unknown; changed: boolean } | { refusal: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { body, changed: false };
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  let changed = false;
  for (const [alias, field] of Object.entries(rules.aliases ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(out, alias)) continue;
    const value = out[alias];
    if (Object.prototype.hasOwnProperty.call(out, field) && !sameValue(out[field], value)) {
      return { refusal: `${rules.door} got ${alias} and ${field} with different values; they are the same field, so send one. Nothing was submitted.` };
    }
    if (!Object.prototype.hasOwnProperty.call(out, field)) out[field] = value;
    delete out[alias];
    changed = true;
  }
  if (rules.keyframeBackendIntoOverrides && Object.prototype.hasOwnProperty.call(out, "keyframe_backend")) {
    const value = out.keyframe_backend;
    const overrides = out.renderOverrides;
    if (overrides !== undefined && (!overrides || typeof overrides !== "object" || Array.isArray(overrides))) {
      return { refusal: `${rules.door} got keyframe_backend with a renderOverrides that is not an object. Nothing was submitted.` };
    }
    const ro = { ...((overrides as Record<string, unknown> | undefined) ?? {}) };
    if (Object.prototype.hasOwnProperty.call(ro, "keyframe_backend") && !sameValue(ro.keyframe_backend, value)) {
      return { refusal: `${rules.door} got keyframe_backend and renderOverrides.keyframe_backend with different values; send one. Nothing was submitted.` };
    }
    if (value !== null && value !== undefined) ro.keyframe_backend = value;
    out.renderOverrides = ro;
    delete out.keyframe_backend;
    changed = true;
  }
  return { body: out, changed };
}

/** Where a field that is often sent to the wrong place actually goes. Shown with the refusal. */
const PANEL_CONFIG = "renderOverrides.config";
const FILM_CONFIG = "motion_config";
function hintFor(field: string, allowed: readonly string[]): string | undefined {
  const config = allowed.includes("motion_config") ? FILM_CONFIG : PANEL_CONFIG;
  switch (field) {
    case "quality_tier":
      return "the field is qualityTier";
    case "resolution":
    case "size":
    case "fps":
      return `a motion door setting goes inside ${config}`;
    case "bundle_key":
      return allowed.includes("bundleKey") ? "this door spells it bundleKey" : undefined;
    case "bundleKey":
      return allowed.includes("bundle_key") ? "this door spells it bundle_key" : undefined;
    case "cast_loras":
      return allowed.includes("castLoras") ? "this door spells it castLoras" : undefined;
    case "castLoras":
      return allowed.includes("cast_loras") ? "this door spells it cast_loras" : undefined;
    case "audio_key":
      return allowed.includes("audioKey") ? "this door spells it audioKey" : undefined;
    case "audioKey":
      return allowed.includes("audio_key") ? "this door spells it audio_key" : undefined;
    default:
      return undefined;
  }
}

/** The refusal for a body carrying fields this door does not read, or null when there are none.
 *  A body that is not a JSON object is left for the handler, which already answers it. */
export function unknownSubmitFieldsRefusal(body: unknown, allowed: readonly string[], door: string): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k)).sort();
  if (unknown.length === 0) return null;
  const named = unknown.map((k) => {
    const hint = hintFor(k, allowed);
    return hint ? `${k} (${hint})` : k;
  });
  return `${door} does not read ${unknown.length === 1 ? "this field" : "these fields"}: ${named.join(", ")}. ` +
    `Nothing was submitted. A field this door does not read would have been dropped, and the render would ` +
    `have run without it.`;
}

/** The refusal for a qualityTier this studio does not know, or null when it is absent or known.
 *  Absent stays the documented default (core's DEFAULT_QUALITY_TIER). */
export function qualityTierRefusal(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (!Object.prototype.hasOwnProperty.call(body, "qualityTier")) return null;
  const value = (body as { qualityTier?: unknown }).qualityTier;
  if (value === undefined) return null;
  const known = QUALITY_TIERS.map((t) => t.value);
  if (typeof value === "string" && (known as string[]).includes(value)) return null;
  return `qualityTier must be one of ${known.join(", ")}; got ${JSON.stringify(value)}. Nothing was submitted.`;
}
