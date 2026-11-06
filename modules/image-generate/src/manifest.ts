// Data-only MANIFEST and model lists for image-generate (vivijure-cf#1308).
// Leaf file: a Worker entry may export only classes and its default handler (cf#1244), so the
// manifest lives here and the entry imports it. Tests and tooling import this path directly.
import { MODULE_API, type ModuleManifest } from "./contract";

// The models this module can actually dispatch. Every id here is executable by image-gen.ts; a row
// the module cannot run would be a lie in the studio picker, which is the defect class cf#129 exists
// to kill. This list moved here from the studio's hardcoded src/image-models.ts.
export const MODELS = [
  "@cf/black-forest-labs/flux-2-klein-9b",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-dev",
  "google/nano-banana-2",
  "google/nano-banana-pro",
  "bytedance/seedream-5-pro",
  "bytedance/seedream-5-lite",
  "xai/grok-imagine-image",
  "openai/gpt-image-2",
  "recraft/recraftv4",
];
// Still runnable if a saved session names them. Not on the picker.
// gpt-image-1.5 stays here for the transparent-PNG BYOK path.
// google/imagen-4 has no Cloudflare model page and its schema-input.json 404s (checked 2026-10-30), so
// it left the picker. It stays here so a saved config still resolves. A live check is still owed, and
// #1076 says to drop it after that check.
export const LEGACY_MODELS = [
  "google/imagen-4",
  "openai/gpt-image-1.5",
  "@cf/black-forest-labs/flux-1-schnell",
  "@cf/leonardo/lucid-origin",
  "@cf/leonardo/phoenix-1.0",
  "@cf/lykon/dreamshaper-8-lcm",
  "@cf/stabilityai/stable-diffusion-xl-base-1.0",
];

export const MANIFEST: ModuleManifest = {
  name: "image-generate",
  version: "0.1.3",
  api: MODULE_API,
  hooks: ["image.generate"],
  provides: [{ id: "image-gen", label: "Image generation (FLUX 2 / Nano Banana / SDXL)" }],
  config_schema: {
    // The core's projection reads THIS field to build the catalog rows, exactly as it reads
    // plan-enhance's. Same declaration form, no special-casing of this module's name anywhere.
    model: { type: "enum", values: MODELS, default: MODELS[0], label: "image model" },
  },
  ui: { section: "chat", order: 20 },
};
