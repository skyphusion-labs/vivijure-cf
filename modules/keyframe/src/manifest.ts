// Data-only MANIFEST for keyframe (cf#285).
// Leaf file: no runtime imports beyond the vendored contract constants/types.
// quality-tier-drift (vivijure-core) and local manifest sync import this path so they
// do not pull the module entrypoint's full import graph (runpod-job-log, etc.).
import { MODULE_API, type ModuleManifest } from "./contract";

// Exported so the core's tier-drift guard (tests/quality-tier-drift.test.ts, issue #124) can assert
// this module's quality_tier enum stays in lockstep with the core QUALITY_TIERS set.
export const MANIFEST: ModuleManifest = {
  name: "keyframe",
  version: "0.3.0",
  api: MODULE_API,
  hooks: ["keyframe"],
  provides: [{ id: "gpu-keyframe", label: "GPU Keyframe (SDXL on RunPod)" }],
  config_schema: {
    quality_tier: {
      type: "enum",
      values: ["draft", "standard", "final"],
      default: "final",
      label: "quality tier",
    },
    // Default to a 16:9 landscape keyframe (SDXL-friendly 1344x768). Image-to-video backends conform
    // the clip to the KEYFRAME's aspect ratio (they ignore an aspect_ratio param once given an input
    // image), so a square keyframe forced square clips that the assembler then pillarboxed into 16:9
    // with black bars. A 16:9 keyframe makes the whole chain 16:9. Override via keyframe_config for
    // portrait/square. (fixes the square showcase clips)
    width: { type: "int", default: 1344, min: 512, max: 1536, label: "width" },
    height: { type: "int", default: 768, min: 512, max: 1536, label: "height" },
    steps: { type: "int", default: 30, min: 1, max: 60, label: "diffusion steps" },
    guidance_scale: { type: "float", default: 6.5, min: 0, max: 20, label: "guidance scale" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
  },
  ui: { section: "keyframe", order: 10 },
  // This module is async + GPU-backed, so it implements POST /cancel: the core can stop an in-flight
  // RunPod job (a cancelled render, or an adopted keyframe phase) instead of orphaning it (#327/#328).
  cancelable: true,
  // #454: compact display token for the keyframe-stage backend, so the planner projects it inline
  // instead of hardcoding "SDXL". OPTIONAL/additive, mirrors src/modules/types.ts.
  keyframe_label: "SDXL",
  // cp#270: this module submits to the vivijure-backend endpoint, which may be POOLED across
  // tenants, so it needs the tenant's per-job R2 credential on the invoke envelope. Declared on
  // the MANIFEST rather than decided in core: which modules ride a pooled endpoint is a property
  // of the module, and core must not branch on module identity.
  needs_tenant_r2: true,
};
