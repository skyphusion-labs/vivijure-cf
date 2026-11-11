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
  retained?: string | null;
}

export interface RenderOutput {
  output_key?: string | null;
  project?: string | null;
  clips?: unknown;
  finish_unavailable?: unknown;
  finish_incomplete?: unknown;
  finish_retry_failed?: unknown;
  finish_waiting?: unknown;
  [k: string]: unknown;
}

export interface NormalizedDegrade {
  /** "assemble" | "mux" as reported; null when the studio did not say. */
  at: string | null;
  /** "clips" | "silent_film" as reported; null when the studio did not say. */
  delivered: string | null;
  retained: string | null;
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
export type StageKey =
  | "speech"
  | "master"
  | "dialogue"
  | "film_finish"
  | "content_validation"
  | "plate_check"
  | "keyframes_incomplete"
  | "door_fit";
export const STAGE_KEYS: StageKey[];

/** vivijure-cf#930: one `door_fit` entry, as the panel reads it. */
export interface DoorFitShot {
  shot_id: string;
  /** `swapped` only: the film door and the door the shot was made on instead. */
  from?: string;
  to?: string;
  /** `tails` only: the door that left the tail. */
  door?: string;
  line_seconds: number | null;
  /** The clip the film door makes for this shot. */
  clip_seconds: number | null;
}

export interface StageDegrade {
  stage: StageKey;
  degraded: number;
  reasons: string[];
  /** cf#860: `film_finish` only. The steps that ran. Structural, NOT a degrade. */
  applied?: string[];
  /** cf#860 / fc#1662: `film_finish` only. Steps whose artifact was found in R2 rather than run
   *  -- the wasted-work signal. Carried so it is not re-derived later; it is NOT a degrade and
   *  must never affect a band or light a badge. */
  adopted?: string[];
  /** cf#916: `content_validation` only. Clips that FAILED the picture check. */
  failed?: number;
  /** cf#916: `content_validation` only. Clips the picture check could not look at. */
  unmeasured?: number;
  /** cf#1282: `plate_check`: shot ids whose still may show an extra person. cf#1283:
   *  `keyframes_incomplete`: shot ids that got no still and were left out. */
  shots?: string[];
  /** cf#1283: `keyframes_incomplete` only. Shots the storyboard asked for. */
  expected?: number;
  /** vivijure-cf#930: `door_fit` only. Shots moved to another door for their own clip. */
  swapped?: DoorFitShot[];
  /** vivijure-cf#930: `door_fit` only. Lined shots still left with a silent-mouthing tail. */
  tails?: DoorFitShot[];
}

/** cf#860: `output.film_finish` normalised into the shared `{ degraded, reasons }` form.
 *
 *  Core emits `{ applied, adopted, degraded: string | null }`, and the whole object is `null`
 *  when the chain was never reached -- the same three-state ladder in a different shape:
 *
 *    null / absent      the chain was never reached          -> unmeasured
 *    degraded: null     it ran and applied cleanly           -> none-reported
 *    degraded: "..."    it ran and SHIPPED UNCARDED          -> reported
 *
 *  Returns null for an unreadable shape, INCLUDING an object with no `degraded` key at all:
 *  core always emits that key, so its absence is a shape we do not recognise, and reading an
 *  unrecognised shape as "ran clean" is the one direction this must never fail in. */
export function parseFilmFinish(raw: unknown): {
  degraded: number;
  reasons: string[];
  applied: string[];
  adopted: string[];
} | null;

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

/** core#377: one finish step that did not run. */
export interface FinishIncomplete {
  stage: string;
  step: string;
  kept: string;
  detail: string;
  shot_id: string;
}
export function incompleteFrom(output: RenderOutput | null | undefined): FinishIncomplete[] | null;
export function incompleteSummary(list: FinishIncomplete[] | null | undefined): string | null;
export function completedStatus(
  output: RenderOutput | null | undefined,
  limited: boolean,
): { text: string; tone: "warn" | "success"; retry: boolean };
export function canRetryFinish(jobId: unknown): boolean;
export function retryFailedNote(output: RenderOutput | null | undefined): string | null;
export function waitingLabel(output: RenderOutput | null | undefined): string | null;

/** cf#916: `output.content_validation` (core `contentValidationView`):
 *  `{ checked, unmeasured, reasons, degraded?: { shot_id, reason }[] }`. `degraded` here is the
 *  count of failed plus unmeasured clips; `reasons` carries `<shot>: <reason>` for each failure, then
 *  the deduped unmeasured reasons verbatim. null when the shape is not recognised. */
export function parseContentValidation(raw: unknown): {
  degraded: number;
  reasons: string[];
  failed: number;
  failedShots: string[];
  unmeasured: number;
} | null;

/** cf#1282: `output.plate_check` (core `plateCheckView`): `{ checked, unclean: { shot_id }[] }`. */
export function parsePlateCheck(raw: unknown): { degraded: number; reasons: string[]; shots: string[] } | null;

/** cf#1283: `output.keyframes_incomplete` (core film-model): `{ adopted, expected, dropped }`. */
export function parseKeyframesIncomplete(raw: unknown): {
  degraded: number;
  reasons: string[];
  shots: string[];
  expected: number;
} | null;

/** vivijure-cf#930: `output.door_fit` (core door-fit.ts): `{ swapped, tails }`. */
export function parseDoorFit(raw: unknown): { degraded: number; reasons: string[]; swapped: DoorFitShot[]; tails: DoorFitShot[] } | null;

/** The shot ids `output.plate_check` names as unclean. Empty for clean, absent or junk. */
export function plateUncleanShots(output: RenderOutput | null | undefined): string[];

/** True only when a keyframe entry carries `plate_count.clean === false`. */
export function keyframeUnclean(kf: unknown): boolean;

/** Plain-words warnings for one shot's still or clip. Empty when there is nothing to say. */
export function shotWarnings(output: RenderOutput | null | undefined, shotId: string, kf?: unknown): string[];

/** Plain lines for the one-screen Make a video page: no shot ids. Empty when nothing to say. */
export function simpleWarnings(output: RenderOutput | null | undefined): string[];
/** cf#1385: `output.keyframe_reuse` (core#532): stills the backend returned from its store. */
export interface KeyframeReuse {
  stills: number;
  reused: string[];
}
/** Null for absent, junk, or an empty list. */
export function parseKeyframeReuse(raw: unknown): KeyframeReuse | null;
/** The shot ids `output.keyframe_reuse` names as reused. Empty for none, absent or junk. */
export function keyframeReusedShots(output: RenderOutput | null | undefined): string[];
/** True when this still was reused, from its own entry or the render-level list. */
export function keyframeReused(
  output: RenderOutput | null | undefined,
  kf: { shot_id?: unknown; reused?: unknown } | null | undefined,
): boolean;
/** One line for a row that reused any still, or "" when none was. */
export function reuseNote(output: RenderOutput | null | undefined): string;
export const STILL_REUSED_TAG: string;
export const STILL_REUSED_TITLE: string;
export const NEW_PICTURE_HINT: string;

/** The sentence shown beside a still made from a plate that may show an extra person. */
export const STILL_EXTRA_PERSON: string;
