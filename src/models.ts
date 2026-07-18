// Shared model-row types for the studio catalog.
//
// This file holds TYPES ONLY. It deliberately contains no model names.
//
// History (cf#62, then cf#129): this was a ~66-row hardcoded catalog spanning chat / image / video
// / tts / stt / music / voice. cf#62 removed the planning rows once plan.enhance began declaring
// its own models; cf#129 removed the remaining 55 dead rows. They were dead in the strict sense:
// findModel() was consulted in exactly two places and BOTH only asked `type === "image"`, and no
// route existed for video / tts / stt / music / voice (nor for /api/chat/stream, which is what the
// old `streaming` flag gated). cf#129 phase 2 then deleted the surviving image rows too: they are
// PROJECTED from installed image.generate modules now (src/module-catalog.ts), so this host holds
// no model names of any kind.
//
// Do NOT add model names here. Under the bare-skeleton doctrine the studio hardcodes none: the
// planning catalog is projected from installed plan.enhance modules (src/planning-models.ts), and
// the image catalog follows in cf#129 phase 2 via its own hook plus declaring module.

// The full type union is retained (rather than narrowed to chat|image) so this file stays
// key-identical to vivijure-local/src/models.ts: public/ is a verbatim-shared surface between the
// two hosts, and a divergence in the row type is exactly the drift the shared panel cannot absorb.
export type ModelType = "chat" | "image" | "tts" | "video" | "stt" | "music" | "voice";

// Kept in sync with vivijure-local/src/models.ts. "xai" was dropped in cf#129 along with the last
// xAI rows; local never carried it.
export type Provider =
  | "workers-ai"
  | "anthropic"
  | "google"
  | "openai"
  | "bytedance"
  | "minimax"
  | "runwayml"
  | "alibaba"
  | "pixverse"
  | "vidu"
  | "recraft";

/** One catalog row, as served on the wire. This shape is SHARED with vivijure-local and is what
 *  both GET /api/models and GET /api/storyboard/models emit; the panel renders any row generically
 *  and filters on `type`. Adding a field is a shared-surface change: upstream in local first. */
export interface ModelEntry {
  id: string;
  label: string;
  group: string;
  type: ModelType;
  // "vision" = accepts image input in chat; "image-input" = image-to-video source image required.
  capabilities: Array<"vision" | "image-input">;
  provider?: Provider; // defaults to "workers-ai" when omitted
}
