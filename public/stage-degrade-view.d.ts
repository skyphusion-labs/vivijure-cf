// Types for the pure helpers in stage-degrade-view.js (cf#864).
// Hand-authored (no build step) so tests typecheck under the CI tsc gate.
import type { RenderOutput, StageDegrade, StageKey } from "./finish-degrade.js";

/** Anything that can make elements. `document` in the browser, a stub under Node. */
export interface ElementFactory {
  createElement(tag: string): StageBlockElement;
}

/** The subset of an element this builder touches. */
export interface StageBlockElement {
  className?: string;
  textContent?: unknown;
  setAttribute?(name: string, value: string): void;
  appendChild(child: StageBlockElement): unknown;
  [k: string]: unknown;
}

/** The finish-degrade surface this module needs, injected rather than read off a global. */
export interface StageDegradeSource {
  STAGE_KEYS: StageKey[];
  stageFrom(output: RenderOutput | null | undefined, key: StageKey | string): StageDegrade | null;
  stageSummary?(info: StageDegrade | null | undefined): string | null;
}

export interface StageBlockOptions {
  className?: string;
  role?: string;
}

/** Every stage the payload REPORTS a degrade for, in declared order. Empty for a film whose
 *  stages all ran clean AND for one whose stages were never reached -- `stageFrom` is null for
 *  both, and neither is a limit. */
export function reportedStages(
  output: RenderOutput | null | undefined,
  fd: StageDegradeSource | null | undefined,
): StageDegrade[];

/** One block per reported stage. EMPTY when there is nothing to report. */
export function stageBlocks(
  doc: ElementFactory | null | undefined,
  infos: StageDegrade[] | null | undefined,
  summarize: ((info: StageDegrade | null | undefined) => string | null) | null | undefined,
  opts?: StageBlockOptions,
): StageBlockElement[];

/** The whole pipeline: raw payload -> the blocks to append. */
export function stageBlocksFor(
  doc: ElementFactory | null | undefined,
  output: RenderOutput | null | undefined,
  fd: StageDegradeSource | null | undefined,
  opts?: StageBlockOptions,
): StageBlockElement[];
