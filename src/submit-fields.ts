// cf#896: a submit door refuses a field it does not read, and a quality tier it does not know.
//
// THE FAILURE THIS CLOSES. `readBody` is a cast, so every submit door accepted any JSON object and
// read only the fields it knew. A caller that sent `quality_tier: "draft"` (the door reads
// `qualityTier`) or a top-level `resolution: "480p"` (no door reads it; it belongs in the motion
// config) got a 201 and a render at `final` and at the motion door's default size. Nothing in the
// record showed the difference. A misspelt field is now a 400 that names it, before any spend.
//
// THE LISTS ARE EXACT. Each one is the set of fields its handler reads, and index.ts holds each list
// equal to its handler's body type at compile time, so a field added to a handler and not to its
// list (or the reverse) is a type error. Two documented aliases stay accepted and ignored on purpose:
// `shardCount` / `shard_count` (CONTRACT 2.23, film scatter is retired).
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
  "shard_count", "shardCount", "delivery_width", "delivery_height", "reuse_finished",
  "idempotency_key", "idempotencyKey", "projectId",
] as const;

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
