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
 *  clean verdict -- it means this payload reports no assemble/mux soft-degrade.
 *
 *  STALE CLAIM CORRECTED (cf#853): this said `film_finish.degraded` "does not exist yet".
 *  It exists. vivijure-core emits it from `render-output-payload.js`
 *  (`out.film_finish = filmFinishView(job.film_finish)`), on the single-film and the scatter
 *  path, as `{ applied, adopted, degraded: string | null }` -- the SAME three-state ladder in
 *  a different shape (`null` degraded means ran-clean, absent means never reached). What is
 *  true is that nothing in `public/` READS it yet, so title-card and subtitle degrades are
 *  still outside every band on every row. A comment asserting a field does not exist is how
 *  a live projection goes unread, so the fact is stated rather than the guess. */
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

/** cf#853 / core#317: the per-stage degrade keys, all in the `{ degraded, reasons }`
 *  vocabulary `output.finish` already uses.
 *
 *  THE LADDER, three states and not two:
 *    key ABSENT      -> the stage was never reached. NOT MEASURED. Show nothing.
 *    degraded: 0     -> it ran and ran clean. Measured, and NOT a limit.
 *    degraded: n > 0 -> it ran and degraded; `reasons` are the studio's own words.
 *
 *  `degraded` is the COUNT and `reasons` is DEDUPED, so `degraded >= reasons.length`; the
 *  two are not interchangeable. */
export type StageKey = "speech" | "master" | "dialogue";
export const STAGE_KEYS: StageKey[];

export interface StageDegrade {
  stage: StageKey;
  degraded: number;
  reasons: string[];
}

export function stageFrom(
  output: RenderOutput | null | undefined,
  key: StageKey | string | null | undefined,
): StageDegrade | null;
export function stageBand(
  output: RenderOutput | null | undefined,
  key: StageKey | string | null | undefined,
): DegradeBand;
export function stageSummary(info: StageDegrade | null | undefined): string | null;
export function stagesNote(infos: StageDegrade[] | null | undefined): DegradeBandNote | null;

/** The COMPOSITION of several band readings, never a worst-of collapse. `limited` answers
 *  "did any signal REPORT a limit" and nothing wider; `fullyMeasured` is the fact a
 *  worst-of would erase. */
export interface BandComposition {
  reported: number;
  unreadable: number;
  noneReported: number;
  unmeasured: number;
  total: number;
  limited: boolean;
  fullyMeasured: boolean;
}

export function combineBands(bands: (DegradeBand | string)[] | null | undefined): BandComposition;
