// Data-only MANIFEST for finish-upscale (vivijure-cf#1308).
// Leaf file: a Worker entry may export only classes and its default handler (cf#1244), so the
// manifest lives here and the entry imports it. Tests and tooling import this path directly.
import { MODULE_API, type ModuleManifest } from "./contract";

// Exported (cf#537) so a test can run conformance against the SHIPPED manifest rather than
// against a transcribed copy in the test file. finish-lipsync already exported its own.
export const MANIFEST: ModuleManifest = {
  name: "finish-upscale",
  version: "0.2.2",
  api: MODULE_API,
  hooks: ["finish"],
  // max_invocation_seconds: the ceiling THIS module declares to the core (core#182 / core#223).
  //
  // BASIS (cf#762): UNIFORM BY DECLARATION, and unmeasurable today. The endpoint id is a Secrets
  // Store value this repo does not carry, and per cf#757 the endpoint this module was pinned to
  // (4q8idwbk6tyqbq, vivijure-upscale) NO LONGER EXISTS: RunPod list-endpoints returns total: 2
  // (vivijure-backend, vivijure-wan-train) on 2026-09-27. There is no worker to measure, so no value
  // here can be justified against one; 900 is held as a conservative declaration, matching the other
  // two finish doors and staying under the crossover below. When this module is repointed or rebuilt
  // (a spend decision, cf#757), derive this number from that worker's own guard and update this
  // comment with the command that establishes it.
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
    { id: "upscale", label: "Upscale resolution (Real-ESRGAN)" },
  ],
  config_schema: {
    style: { type: "enum", values: ["photoreal", "anime"], default: "photoreal", label: "still look" },
    // core#389: the default is the target, so the module never buys a fixed factor by default. The core
    // fills a schema default into every config, so a default of 2 read as an explicit 2x on every film.
    scale: { type: "int",  default: 0, min: 0, max: 4, label: "upscale size", enum_labels: { "0": "to delivery height", "2": "2x", "4": "4x" } },
    model: { type: "enum", values: ["realesr-animevideov3", "RealESRGAN_x4plus"], default: "realesr-animevideov3", label: "model" },
  },
  ui: { section: "finish", icon: "expand", order: 20 },
  finish_scales_frame: true,
  // cf#1038: the owned upscale endpoint is gone. MuseTalk is gone. Default-on now degrades
  // every film. opt_in means the chain skips this module unless a caller names it.
  participation: "opt_in",
  // Declared artifact conventions (S6): the Real-ESRGAN container appends _up to the input clip key.
  // Async and GPU-backed, so a cancelled film can stop this job (cf#1109).
  cancelable: true,
  finish_artifacts: {
    output_key: { kind: "append_suffix", suffix: "_up" },
    applied: [{ tag: "upscale:{scale|2}x" }],
  },
};
