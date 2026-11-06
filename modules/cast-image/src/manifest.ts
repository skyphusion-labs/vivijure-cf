// Data-only MANIFEST and model list for cast-image (vivijure-cf#1308).
// Leaf file: a Worker entry may export only classes and its default handler (cf#1244), so the
// manifest lives here and the entry imports it. Tests and tooling import this path directly.
import { MODULE_API, type ModuleManifest } from "./contract";
import { TRAINING_PROMPTS } from "./cast-image";

export const MODELS = [
  "@cf/black-forest-labs/flux-2-klein-9b",
  "google/nano-banana-pro",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-dev",
  "black-forest-labs/flux-3-image-klein",
];

export const MANIFEST: ModuleManifest = {
  name: "cast-image",
  version: "0.1.3",
  api: MODULE_API,
  hooks: ["cast.image"],
  provides: [{ id: "cast-refs", label: "Training references (FLUX 2 / Nano Banana)" }],
  config_schema: {
    model: { type: "enum", values: MODELS, default: MODELS[0], label: "image model" },
    num_images: { type: "int", default: 10, min: 4, max: TRAINING_PROMPTS.length, label: "training images" },
  },
  ui: { section: "cast", order: 10 },
};
