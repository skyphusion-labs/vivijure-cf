// Data-only MANIFEST for finish-rife (vivijure-cf#1308).
// Leaf file: a Worker entry may export only classes and its default handler (cf#1244), so the
// manifest lives here and the entry imports it. Tests and tooling import this path directly.
import { MODULE_API, type ModuleManifest } from "./contract";

// Exported (cf#537) so a test can run conformance against the SHIPPED manifest rather than
// against a transcribed copy in the test file. finish-lipsync already exported its own.
export const MANIFEST: ModuleManifest = {
  name: "finish-rife",
  version: "0.1.3",
  api: MODULE_API,
  hooks: ["finish"],
  // max_invocation_seconds: the ceiling THIS module declares to the core (core#182 / core#223).
  //
  // BASIS (cf#762 / cf#1038): UNIFORM BY DECLARATION. There is no worker to measure. The
  // vivijure-backend endpoint this module dispatched to was deleted 2026-10-29. 900 stays a
  // conservative declaration that matches finish-blender and stays under the crossover below.
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
    { id: "interpolate", label: "Smooth motion (RIFE frame interpolation)" },
    { id: "face_restore", label: "Relock faces (GFPGAN)" },
  ],
  config_schema: {
    style:                { type: "enum",  values: ["photoreal", "anime"], default: "photoreal", label: "still look" },
    interpolate:          { type: "bool",  default: true,   label: "smooth motion" },
    interpolation_factor: { type: "int",   default: 2, min: 1, max: 8, label: "smoothness", enum_labels: { "1": "off", "2": "2x", "4": "4x", "8": "8x" } },
    face_restore:         { type: "enum",  values: ["none", "gfpgan", "codeformer"], default: "none", label: "face restore" },
    face_fidelity:        { type: "float", default: 0.7, min: 0, max: 1, label: "fidelity (0 = max restore, 1 = max fidelity)" },
    only_faces:           { type: "bool",  default: true,   label: "faces only (leave background untouched)" },
  },
  ui: { section: "finish", icon: "wand", order: 10 },
  // cf#1038: the owned backend endpoint is gone. Default-on now degrades every film.
  // opt_in means the chain skips this module unless a caller names it.
  participation: "opt_in",
  // Declared artifact conventions (S6): the container names its output off the shot id, and its
  // applied marker depends on the interpolate knob. The core's R2 recovery reads THIS, not our name.
  // Async and GPU-backed, so a cancelled film can stop this job (cf#1109).
  cancelable: true,
  finish_artifacts: {
    output_key: { kind: "shot_named", filename: "_finished.mp4" },
    applied: [
      { when: { knob: "interpolate", equals: false }, tag: "noop:interpolate-off" },
      { tag: "interpolate:{interpolation_factor|2}x" },
    ],
  },
};
