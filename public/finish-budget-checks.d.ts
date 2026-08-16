// Types for the pure helpers in finish-budget-checks.js (cf#540).
// Hand-authored (no build step) so tests typecheck under the CI tsc gate.

/** A finish module's declared cost, as it appears on its MANIFEST and therefore on
 *  GET /api/modules (registry `toPublic` strips only `binding` and passes the manifest through).
 *
 *  NOT YET DECLARED BY ANY MODULE IN THIS REPO. This shape is the planner's half of a contract
 *  whose other half is a manifest field in vivijure-core's ModuleManifest; until that lands, every
 *  chain resolves UNDECLARED and the planner says so rather than inventing a ceiling. */
export interface FinishCostDecl {
  /** Wall seconds of finish work per second of footage, on the hardware named by measured_on. */
  seconds_per_second: number;
  /** The door's own guard for this module, in seconds (its FFMPEG_TIMEOUT or equivalent).
   *  A module wanting headroom declares a SMALLER budget; the planner adds no margin term of its
   *  own, because a margin constant in the panel would be the fourth constant cf#540 is about. */
  budget_seconds: number;
  /** The hardware the rate was measured on. A rate measured on hardware this render will not
   *  touch is not a rate for this render, so an unmeasured surface stays representable. */
  measured_on?: string;
  /** When the rate was measured. A dated measurement quoted without its date becomes a claim
   *  about now. */
  measured_at?: string;
}

export interface FinishModuleLike {
  name: string;
  provides?: Array<{ id?: string; label?: string }>;
  /** cf#537. "opt_in" means the module runs only when a caller NAMES it. */
  participation?: "default" | "opt_in";
  finish_cost?: FinishCostDecl | null;
  [key: string]: unknown;
}

/** Mirrors vivijure-core's HookSelection for the `finish` hook. */
export type FinishSelection =
  | { mode: "default" }
  | { mode: "named"; modules: string[] };

export interface NormalizedCost {
  rate: number;
  budget: number;
  measuredOn: string | null;
  measuredAt: string | null;
}

export interface BindingCost {
  maxSeconds: number;
  module: FinishModuleLike;
  cost: NormalizedCost;
}

export interface FinishBudget {
  /** "derived" carries a number (or null for an empty chain, which constrains nothing).
   *  "undeclared" and "unavailable" are absences with DIFFERENT owners and must not be merged.
   *  "unresolved" (cf#593) is a named selection the studio does not serve -- not an empty chain. */
  state: "derived" | "undeclared" | "unavailable" | "unresolved";
  maxSeconds: number | null;
  binding?: BindingCost;
  chain: FinishModuleLike[];
  declared: Array<{ module: FinishModuleLike; cost: NormalizedCost }>;
  undeclared: FinishModuleLike[];
  /** Named-but-not-serving module ids. Empty except when state is "unresolved". */
  missing: string[];
}

/** Same shape the server preflight emits, so these merge into the existing issue list. */
export interface FinishBudgetIssue {
  level: "error" | "warning" | "info";
  scope: string;
  message: string;
}

export interface SceneLike {
  id?: string;
  target_seconds?: number;
  [key: string]: unknown;
}

export interface StoryboardLike {
  scenes?: SceneLike[];
  clip_seconds?: number;
  [key: string]: unknown;
}

export const DERIVED: string;
export const UNDECLARED: string;
export const UNAVAILABLE: string;
export const UNRESOLVED: string;
export function label(mod: FinishModuleLike | null | undefined): string;
export function selectedFinishModules(
  serving: FinishModuleLike[] | null | undefined,
  selection?: FinishSelection | null,
): FinishModuleLike[];
/** Mirrors core's ChainSelection: serving intersection plus named-but-not-serving ids (cf#593). */
export function selectedFinishChain(
  serving: FinishModuleLike[] | null | undefined,
  selection?: FinishSelection | null,
): { modules: FinishModuleLike[]; missing: string[] };
export function costOf(mod: FinishModuleLike | null | undefined): NormalizedCost | null;
export function finishBudget(
  serving: FinishModuleLike[] | null | undefined,
  selection: FinishSelection | null | undefined,
  registryUnavailable: boolean,
): FinishBudget;
export function finishBudgetIssues(
  storyboard: StoryboardLike | null | undefined,
  budget: FinishBudget | null | undefined,
  /** cf#579: the INSTALLED finish modules, so the per-render notice can state N of M. Omit it and
   *  the notice prints no denominator rather than a wrong one. */
  installed?: FinishModuleLike[] | null,
): FinishBudgetIssue[];

/** cf#579: the registry-derived coverage census.
 *
 *  `declared` and `installed` are NUMBERS when state is "measured" and NULL when the registry could
 *  not be read. Null rather than zero is the load-bearing part: a zero here is a measurement, and
 *  reporting one we did not take is the collapse the per-render path already refuses. */
export interface FinishCostCoverage {
  state: "measured" | "unavailable";
  declared: number | null;
  installed: number | null;
  declaredModules: FinishModuleLike[];
  undeclared: FinishModuleLike[];
}

export const MEASURED: string;
/** Census over the INSTALLED finish modules (the registry projection), not over one render's
 *  selection: an opt_in module that declares nothing is still a hole in the studio's coverage. */
export function finishCostCoverage(
  installed: FinishModuleLike[] | null | undefined,
  registryUnavailable: boolean,
): FinishCostCoverage;
/** The machine-readable triple. Empty strings, never "0", when the registry could not be read. */
export function coverageAttrs(cov: FinishCostCoverage | null | undefined): {
  "data-finish-cost-state": string;
  "data-finish-cost-declared": string;
  "data-finish-cost-installed": string;
};
export function coverageText(cov: FinishCostCoverage | null | undefined): string;

