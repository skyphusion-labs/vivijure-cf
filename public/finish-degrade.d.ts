// Types for the pure helpers in finish-degrade.js (cf#118).
// Hand-authored (no build step) so tests typecheck under the CI tsc gate.

export interface DeliveredClip {
  shot_id: string;
  key: string;
}

/** `output.finish_unavailable` as the core poll bridge emits it, plus the clips that ride
 *  alongside it on the same output object. */
export interface FinishUnavailable {
  at?: string | null;
  reason?: string | null;
  delivered?: string | null;
}

export interface RenderOutput {
  output_key?: string | null;
  project?: string | null;
  clips?: unknown;
  finish_unavailable?: unknown;
  [k: string]: unknown;
}

export interface NormalizedDegrade {
  /** "assemble" | "mux" as reported; null when the studio did not say. */
  at: string | null;
  /** "clips" | "silent_film" as reported; null when the studio did not say. */
  delivered: string | null;
  /** The studio reason VERBATIM, or NO_REASON when it gave none. */
  reason: string;
  clips: DeliveredClip[];
}

export interface Deliverable {
  kind: "film" | "clips" | "none";
  key: string | null;
  clips: DeliveredClip[];
}

export const NO_REASON: string;
export function clipsFrom(output: RenderOutput | null | undefined): DeliveredClip[];
export function degradeFrom(output: RenderOutput | null | undefined): NormalizedDegrade | null;
export function deliverable(output: RenderOutput | null | undefined): Deliverable;
export function deliveredSummary(degrade: NormalizedDegrade | null | undefined): string | null;
