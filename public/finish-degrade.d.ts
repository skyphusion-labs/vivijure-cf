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

/** cf#549: the four bands render history has to keep apart. "none-reported" is NOT a
 *  clean verdict -- it means this payload reports no assemble/mux soft-degrade, and says
 *  nothing about `film_finish.degraded` (vivijure-core#203), which does not exist yet. */
export type DegradeBand = "unmeasured" | "none-reported" | "unreadable" | "reported";

export interface DegradeBandNote {
  label: string;
  title: string;
}

export const DEGRADE_BANDS: {
  UNMEASURED: "unmeasured";
  NONE_REPORTED: "none-reported";
  UNREADABLE: "unreadable";
  REPORTED: "reported";
};

export function degradeBand(output: RenderOutput | null | undefined): DegradeBand;
/** null for the bands that must render nothing ("unmeasured", "none-reported") and for
 *  any unrecognised value. */
export function bandNote(band: DegradeBand | string | null | undefined): DegradeBandNote | null;

/** Clip-level finish reasons from `output.finish` (core#226 / cf#595). */
export interface ClipFinishDegrade {
  degraded: number;
  reasons: string[];
}

export function clipFinishFrom(output: RenderOutput | null | undefined): ClipFinishDegrade | null;
export function clipFinishBand(output: RenderOutput | null | undefined): DegradeBand;
export function clipFinishSummary(clip: ClipFinishDegrade | null | undefined): string | null;
