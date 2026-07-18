// Image-generation catalog for POST /api/chat (cast portrait + multi-scene preview).
//
// Mirrors vivijure-local/src/image-models.ts: same file name, same export names, same row shape.
// The two hosts are parity-absolute, and this surface drifted once already (cf#129 found cf serving
// eleven ids and local ten, differing by @cf/leonardo/lucid-origin) precisely because the catalog
// was maintained twice by hand.
//
// THIS IS TRANSITIONAL. cf#129 phase 2 replaces it with a projection over the installed modules
// that DECLARE these models, the same way src/planning-models.ts already projects the planning
// catalog off plan.enhance. It is hardcoded here only because no hook currently exists whose
// modules declare the image-generation set: cast.image declares four LoRA training-reference
// models against a dispatch path that supports all of these, so projecting off it today would cut
// the picker to the wrong four. Deleting these rows is phase 2 work, not a follow-up to forget.

import type { ModelEntry } from "./models";

/** The image models POST /api/chat can actually dispatch. Every row here is executable by
 *  src/chat-image.ts: the proxied rows via buildProxiedImageParams, the rest via the generic
 *  @cf text-to-image path. A row whose model the host cannot run would be a lie in the picker. */
export const IMAGE_MODELS: ModelEntry[] = [
  { id: "google/nano-banana-pro", label: "Nano Banana Pro (Google)", group: "Image Gen", type: "image", capabilities: [], provider: "google" },
  { id: "openai/gpt-image-1.5", label: "GPT Image 1.5 (OpenAI; transparent PNG with OPENAI_API_KEY, else opaque)", group: "Image Gen", type: "image", capabilities: [], provider: "openai" },
  { id: "recraft/recraftv4", label: "Recraft V4 (art-directed, opaque)", group: "Image Gen", type: "image", capabilities: [], provider: "recraft" },
  { id: "@cf/black-forest-labs/flux-2-klein-9b", label: "FLUX 2 Klein 9B (frontier)", group: "Image Gen", type: "image", capabilities: [] },
  { id: "@cf/black-forest-labs/flux-2-klein-4b", label: "FLUX 2 Klein 4B (faster)", group: "Image Gen", type: "image", capabilities: [] },
  { id: "@cf/black-forest-labs/flux-2-dev", label: "FLUX 2 Dev (multi-reference)", group: "Image Gen", type: "image", capabilities: [] },
  { id: "@cf/black-forest-labs/flux-1-schnell", label: "FLUX-1 schnell (fast)", group: "Image Gen", type: "image", capabilities: [] },
  { id: "@cf/leonardo/lucid-origin", label: "Lucid Origin (Leonardo)", group: "Image Gen", type: "image", capabilities: [] },
  { id: "@cf/leonardo/phoenix-1.0", label: "Phoenix 1.0 (Leonardo)", group: "Image Gen", type: "image", capabilities: [] },
  { id: "@cf/lykon/dreamshaper-8-lcm", label: "Dreamshaper 8 LCM (fast SD)", group: "Image Gen", type: "image", capabilities: [] },
  { id: "@cf/stabilityai/stable-diffusion-xl-base-1.0", label: "Stable Diffusion XL (SDXL)", group: "Image Gen", type: "image", capabilities: [] },
];

/** The catalog row for an image model id, or undefined. Named to match local exactly; replaced the
 *  old findModel(), whose name implied a catalog far wider than what it could ever return. */
export function findImageModel(id: string): ModelEntry | undefined {
  return IMAGE_MODELS.find((m) => m.id === id);
}
