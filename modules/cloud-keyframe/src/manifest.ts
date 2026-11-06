// Data-only MANIFEST for cloud-keyframe (vivijure-cf#1308).
// Leaf file: a Worker entry may export only classes and its default handler (cf#1244), so the
// manifest lives here and the entry imports it. Tests and tooling import this path directly.
import { MODULE_API, type ModuleManifest } from "./contract";
import { MODELS } from "./keyframe";

export const MANIFEST: ModuleManifest = {
  name: "cloud-keyframe",
  version: "0.1.13",
  cancelable: true,
  api: MODULE_API,
  hooks: ["keyframe"],
  provides: [{ id: "cloud-keyframe", label: "Cloud Keyframe (reference-conditioned, GPUless)" }],
  config_schema: {
    model: {
      type: "enum",
      values: [...MODELS],
      default: MODELS[0],
      label: "image model",
    },
    // Default to a LANDSCAPE keyframe (1344x768), matching the GPU keyframe module. MIND THE RATIO:
    // 1344/768 is 1.75 (7:4), NOT 16:9 (1.7778). Image-to-video backends conform the clip to the
    // KEYFRAME's aspect ratio, so a square keyframe forces square clips that the assembler then
    // pillarboxes. A landscape keyframe removes most of that; the residual 1.75 vs 1.7778 mismatch
    // against the 1920x1080 delivery target is cf#945.
    width: { type: "int", default: 1344, min: 512, max: 1536, label: "width" },
    height: { type: "int", default: 768, min: 512, max: 1536, label: "height" },
    refs_per_slot: { type: "int", default: 1, min: 1, max: 4, label: "reference images per character" },
    // cp#32: one film-wide reference appended to EVERY shot (character-less shots included) to lock
    // style/realism across the film. STRING not enum: the cast anchor <slot> is per-project and a
    // static enum cannot carry it. Grammar: none | first_keyframe | cast:<slot>. After plate-first,
    // shot 1 is the scene lock, so the default is first_keyframe (not a portrait borrow).
    film_ref: { type: "string", default: "first_keyframe", label: "film-wide reference lock (none | first_keyframe | cast:<slot>)" },
    style: {
      type: "enum",
      values: ["photoreal", "anime"],
      default: "photoreal",
      label: "still look",
    },
  },
  ui: { section: "keyframe", order: 5 },
};
