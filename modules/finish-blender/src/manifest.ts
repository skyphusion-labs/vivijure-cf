// Data-only MANIFEST for finish-blender (vivijure-cf#1308).
// Leaf file: a Worker entry may export only classes and its default handler (cf#1244), so the
// manifest lives here and the entry imports it. Tests and tooling import this path directly.
import { MODULE_API, type ModuleManifest } from "./contract";

// Exported (cf#537) so a test can run conformance against the SHIPPED manifest rather than
// against a transcribed copy in the test file. finish-lipsync already exported its own.
export const MANIFEST: ModuleManifest = {
  name: "finish-blender",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["finish"],
  // max_invocation_seconds: the ceiling THIS module declares to the core (core#182 / core#223).
  //
  // BASIS (cf#762): the vivijure-blender worker's own deploy configuration. EXECUTION_TIMEOUT_MS
  // defaults to 900000 (900s) in that repo's deploy.sh and is passed as executionTimeoutMs on
  // endpoint create, so it is what actually terminates an over-running invocation:
  //     gh api repos/skyphusion-labs/vivijure-blender/contents/deploy.sh?ref=main -q .content \
  //       | base64 -d | grep EXECUTION_TIMEOUT_MS
  // NOT read off a running endpoint, and the reason is worth stating: no vivijure-blender endpoint
  // exists. RunPod list-endpoints returns total: 2 (vivijure-backend t9wcvlxh8rc5la,
  // vivijure-wan-train zqb7tougbqfkqa) on 2026-09-27, and vivijure-control-plane/src/satellite-pins.ts
  // carries no blender pin at all. So this is the worker's declared configuration, not a live reading.
  //
  // REFUTED: 5400, which cf#762 inherited from a superseded PR. 5400 is vivijure-blender handler.py's
  // own PHASE_HARD_DEADLINE_SECONDS -- the studio ceiling that door must stay UNDER ("Do not raise
  // that ceiling to match this door; keep this door under it"), not a duration the worker permits.
  // Declaring it here would take the number the door is measured against and hand it back as the
  // measurement. The worker's real worst case is declared_budget_seconds("composite") = 4320s at the
  // defaults (2*300 download + 2*480 extract + 60 + 120 probe + 1800 blender + 480 encode + 300
  // upload), and even that is a sum of per-leg guards rather than an invocation ceiling.
  //
  // RAISING THIS IS A GLOBAL DECISION, NOT A LOCAL ONE. The core derives its phase stall ceiling
  // from the largest declared ceiling in the chain (vivijure-core phaseCeiling, src/film-model.ts):
  //     required  = FINISH_STEP_MAX_ATTEMPTS(3) * max(declared ceiling over the steps that run next)
  //     effective = max(PHASE_HARD_DEADLINE_SECONDS(5400), required)
  // At 900, required is 2700: under the floor, so the floor wins and this number changes nothing.
  // 1800 IS THE CROSSOVER. At 1800, required is exactly 5400 and basis stays "floor". At 1801 it is
  // 5403, basis flips to "derived", and the deadline moves for EVERY film whose finish chain can
  // reach this module -- the derivation takes the max over the steps that COULD run next, not the
  // one that did. Past 1800 is a deliberate, acknowledged act: register it in
  // ACKNOWLEDGED_ABOVE_CROSSOVER (modules/_shared/finish-ceiling.ts) or the gate in
  // tests/finish-ceiling-crossover-cf762.test.ts fails. cf#762.
  max_invocation_seconds: 900,
  provides: [
    { id: "blender-grade", label: "Color grade (Blender compositor)" },
  ],
  config_schema: {
    job_type: { type: "enum", values: ["grade", "composite"], default: "grade", label: "job" },
    preset: {
      type: "enum",
      values: ["neutral", "filmic_warm", "high_contrast", "cool", "soft"],
      default: "filmic_warm",
      label: "grade preset",
    },
    strength: { type: "float", default: 1, min: 0, max: 2, label: "preset strength" },
  },
  // After rife (10), before upscale (20): grade at native resolution.
  ui: { section: "finish", icon: "palette", order: 18 },
  // cf#537, and this line IS the ticket. `finish` is a chain hook, so binding this module used to be
  // the entire enrolment: it ran on every shot of every film and applied a real `filmic_warm` grade
  // at strength 1.0 to footage nobody asked to grade, while the job reported done / 0 failed /
  // 0 degraded. Conrad ruled a colour grade is for ANIMATION SHOTS, named per render. `opt_in` means
  // the core omits this module from the finish chain unless a caller names it in that render's
  // `select`. Naming it still runs it -- opt_in is "not unless asked", never "not ever".
  participation: "opt_in",
  // Async and GPU-backed, so a cancelled film can stop this job (cf#1109).
  cancelable: true,
  finish_artifacts: {
    output_key: { kind: "append_suffix", suffix: "_bl" },
    applied: [{ tag: "blender:{job_type|grade}:{preset|filmic_warm}" }],
  },
};
