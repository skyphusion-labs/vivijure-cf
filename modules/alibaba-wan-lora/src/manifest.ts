// Data-only MANIFEST for alibaba-wan-lora (vivijure-cf#1308).
// Leaf file: a Worker entry may export only classes and its default handler (cf#1244), so the
// manifest lives here and the entry imports it. Tests and tooling import this path directly.
import { MODULE_API, type ModuleManifest } from "./contract";

export const MANIFEST: ModuleManifest = {
  name: "alibaba-wan-lora",
  version: "0.1.3",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-cloud-lora", label: "Silent, your trained face (Wan)" }],
  config_schema: {
    // The LoRA lists are the whole point: control over cloud i2v. The contract's ConfigField has no
    // array type, so each list rides as a JSON STRING of [{ path, scale }] the module parses (path =
    // URL/path to the LoRA file; HuggingFace URLs supported). Default "[]" = plain Wan 2.2 i2v.
    high_noise_loras: { type: "string", default: "[]", label: "high-noise LoRAs -- JSON [{path,scale}]" },
    low_noise_loras: { type: "string", default: "[]", label: "low-noise LoRAs -- JSON [{path,scale}]" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
  },
  ui: {
    section: "motion",
    order: 75,
    locality: "cloud",
    // cf#1246: provider cost, no markup. Source and date: docs/motion-door-prices.md.
    cost: "$0.35 per 5 s clip, $0.56 per 8 s clip ($0.07/s)",
    cost_as_of: "2026-11-05",
    cost_usd_per_second: [0.07, 0.07],
    blurb: "Detailed motion with your trained face. Silent.",
    limits: [
      "5 or 8 second clips",
      "Silent, with your trained face",
      "No spoken lines. A board with a line needs a talking door",
    ],
  },
  usage: {
    face_hold: "hold",
    native_audio: false,
    voice: "cast_tts",
    scatter_native_audio: false,
    min_seconds: 5,
    max_seconds: 8,
    duration_steps: [5, 8],
    seed: true,
  },
};
