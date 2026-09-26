// Data-only MANIFEST for local-gpu (cf#285).
// Leaf file: no runtime imports beyond the vendored contract constants/types.
// quality-tier-drift (vivijure-core) and local manifest sync import this path so they
// do not pull the module entrypoint's full import graph (runpod-job-log, etc.).
import { MODULE_API, type ModuleManifest } from "./contract";

// Exported so the core's tier-drift guard (tests/quality-tier-drift.test.ts, #124) can assert this
// module's `quality` enum stays in lockstep with the core QUALITY_TIERS set. The enum VALUES are the
// core's shared vocabulary (draft/standard/final); the local backend maps each to an engine config its
// card can HONESTLY deliver ("final" = the card's honest ceiling, NOT datacenter parity) -- LTX scales
// the tiers one way, CogVideoX by inference steps. Same names, backend-specific mapping -- exactly as
// the Wan datacenter backend maps the tiers to its steps.
export const MANIFEST: ModuleManifest = {
  name: "local-gpu",
  version: "0.2.0",
  api: MODULE_API,
  hooks: ["motion.backend", "keyframe"],
  provides: [
    { id: "i2v-local-gpu", label: "Best look (your GPU)" },
    { id: "keyframe-local-gpu", label: "Keyframes on your own GPU" },
  ],
  config_schema: {
    quality: { type: "enum", values: ["draft", "standard", "final"], default: "standard", label: "quality" },
    quality_tier: { type: "enum", values: ["draft", "standard", "final"], default: "final", label: "keyframe quality tier" },
    fps: { type: "int", default: 24, min: 8, max: 30, label: "fps (backend may pin its own; e.g. CogVideoX = 8)" },
    flow_shift: { type: "float", default: 5.0, min: 1, max: 12, label: "motion (flow shift; LTX door only, ignored otherwise)" },
    negative_prompt: { type: "string", default: "", label: "negative prompt (additive)" },
    width: { type: "int", default: 1344, min: 512, max: 1536, label: "keyframe width" },
    height: { type: "int", default: 768, min: 512, max: 1536, label: "keyframe height" },
    steps: { type: "int", default: 30, min: 1, max: 60, label: "keyframe diffusion steps" },
    guidance_scale: { type: "float", default: 6.5, min: 0, max: 20, label: "keyframe guidance scale" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
  },
  ui: {
    section: "motion",
    order: 4,
    locality: "local",
    // local#278: self-host CogVideoX may need registration; commercial product use is via
    // vivijure-cf / Cloudflare partner channels. No cloud API bill on this door.    // local#278: self-host/vivijure-local = hobby + non-commercial; commercial = vivijure-cf.
    cost: "Hardware; self-host non-commercial",
    blurb: "Best look you can keep on your own GPU. Silent clips; add a Cast voice plus MuseTalk if they speak. Self-host only: hobby and non-commercial (vivijure-local). Commercial use is the hosted studio, not this door. Weights carry their own licences (CogVideoX on 16GB, LTX on 12GB).",
    limits: [
      "About 2-8 second silent clips (your door may pin a tighter grid)",
      "Speaking is Cast voice plus MuseTalk",
      "Runs whichever local backend you point it at: LTX (12GB floor) or CogVideoX (16GB floor); bigger cards add headroom",
      "Keyframes (SDXL preview) and short motion clips share the same card serially",
      "One film, no scatter (look door)",
      "One GPU job at a time (a consumer card runs a single preview or motion job)",
      "Self-host / vivijure-local: hobby and non-commercial only (local#278). Commercial product use: vivijure-cf",
    ],
  },
  usage: {
    native_audio: false,
    voice: "cast_tts",
    scatter_native_audio: false,
    min_seconds: 2,
    max_seconds: 8,
    seed: true,
  },
  cancelable: true,
  keyframe_label: "SDXL (local)",
};
