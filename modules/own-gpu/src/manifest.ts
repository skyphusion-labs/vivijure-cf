// Data-only MANIFEST for own-gpu (cf#285).
// Leaf file: no runtime imports beyond the vendored contract constants/types.
// quality-tier-drift (vivijure-core) and local manifest sync import this path so they
// do not pull the module entrypoint's full import graph (runpod-job-log, etc.).
import { MODULE_API, type ModuleManifest } from "./contract";

// Exported so the core's tier-drift guard (tests/quality-tier-drift.test.ts, issue #124) can assert
// this module's `quality` enum stays in lockstep with the core QUALITY_TIERS set.
export const MANIFEST: ModuleManifest = {
  // cp#270: this module submits to the vivijure-backend endpoint, which may be POOLED across
  // tenants, so it needs the tenant's per-job R2 credential on the invoke envelope. Declared on
  // the MANIFEST rather than decided in core: which modules ride a pooled endpoint is a property
  // of the module, and core must not branch on module identity.
  needs_tenant_r2: true,
  name: "own-gpu",
  version: "0.2.1",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-own-gpu", label: "Best look (studio GPU)" }],
  config_schema: {
    quality: { type: "enum", values: ["draft", "standard", "final"], default: "standard", label: "quality" },
    fps: { type: "int", default: 16, min: 8, max: 30, label: "fps" },
    flow_shift: { type: "float", default: 5.0, min: 1, max: 12, label: "motion (flow shift, lower = faster)" },
    negative_prompt: { type: "string", default: "", label: "negative prompt (additive)" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
  },
  ui: { section: "motion", order: 5, locality: "byo", cost: "Highest quality, slower", blurb: "Our studio GPU. Best look. Cloud doors finish faster." },
};
