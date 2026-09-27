// The finish-chain ceiling crossover (cf#762).
//
// WHY THIS FILE EXISTS. `max_invocation_seconds` in a module manifest looks like a local number
// about one module. It is not. The core derives a GLOBAL per-phase deadline from the largest one
// in play (`phaseCeiling`, vivijure-core `src/film-model.ts`):
//
//     required  = FINISH_STEP_MAX_ATTEMPTS * max(declared ceiling over the steps that could run next)
//     effective = max(PHASE_HARD_DEADLINE_SECONDS, required)
//
// PHASE_HARD_DEADLINE_SECONDS is a FLOOR, not a constant: it wins only while `required` is under it.
// The crossover is therefore PHASE_HARD_DEADLINE_SECONDS / FINISH_STEP_MAX_ATTEMPTS, which is 5400/3
// = 1800 today. At a declared 1800, `required` is exactly 5400, `basis` stays "floor" and nothing
// moves. At 1801 `required` is 5403, `basis` flips to "derived", and every film whose finish chain
// can reach that module now runs against a longer stall ceiling -- including the films that never
// invoke it, because the derivation takes the MAX over the steps that could run next, not the one
// that did. That is why raising one module's ceiling is a global decision and not a local one.
//
// Both terms are IMPORTED, never typed here. If core moves either, this value moves with it and the
// gate in tests/finish-ceiling-crossover-cf762.test.ts reports the new number rather than silently
// grading against a stale one. That test also pins the value at 1800, so a core change that moves
// the crossover goes RED and sends the next reader back to the comments that name 1800.
//
// This module is imported by the gate, not by any Worker: it must never grow runtime behaviour.

import {
  PHASE_HARD_DEADLINE_SECONDS,
  FINISH_STEP_MAX_ATTEMPTS,
} from "@skyphusion-labs/vivijure-core/film-model";

/**
 * The largest `max_invocation_seconds` a finish/speech module can declare while core's effective
 * phase ceiling stays on its floor. Declared > this and the global deadline starts moving.
 */
export const CEILING_CROSSOVER_SECONDS = PHASE_HARD_DEADLINE_SECONDS / FINISH_STEP_MAX_ATTEMPTS;

export interface CeilingAcknowledgement {
  /** The declared value being acknowledged. Must match the module manifest exactly. */
  seconds: number;
  /**
   * WHY this module is allowed past the crossover, and what it does to the global deadline. State
   * the resulting `effective` seconds (3 * declared) and who accepted it. A reason that does not
   * name the consequence is not an acknowledgement; it is a suppression.
   */
  reason: string;
}

/**
 * Modules deliberately declaring ABOVE the crossover.
 *
 * EMPTY IS THE CORRECT STATE. Nothing in the tree crosses 1800 today: finish-blender, finish-rife
 * and finish-upscale all declare 900, so `required` is 2700 and the floor holds. An entry here is a
 * decision to move the deadline for every film in the estate, so it is made once, in the open, with
 * its consequence written down -- not by editing a manifest line and watching the suite stay green.
 */
export const ACKNOWLEDGED_ABOVE_CROSSOVER: Record<string, CeilingAcknowledgement> = {};
