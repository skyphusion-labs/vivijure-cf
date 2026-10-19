// Types for scripts/check-capability-matrix.mjs, so tests/capability-matrix-gate-830.test.ts gets a
// real contract instead of `any`. The script stays .mjs because it runs as a bare `node` CI step with
// no build; this file is the seam that lets the type checker see it (vivijure#830).

export interface MatrixTransition {
  name: string;
  direction: string;
  issue: string;
}

export interface MatrixVerdict {
  /** Every disagreement, already worded for the operator. Empty means the gate passes. */
  problems: string[];
  /** The names a declared transition tolerated this run. */
  exempt: Set<string>;
  /** One line per applied exemption, for the run log. */
  notes: string[];
}

/** The files that make a directory a module. Shared by the population and the hook count. */
export const MODULE_ENTRY_FILES: string[];

/** True when a directory really holds a module. `exists` is injected so both answers are testable
 *  without touching disk (vivijure#831). */
export function isModuleDirectory(name: string, exists: (path: string) => boolean): boolean;

export function parseMatrixModules(markdown: string): { found: string[]; rows: number };

export function parseTransitions(text: string): {
  transitions: MatrixTransition[];
  errors: string[];
};

export function parseRetiredNames(markdown: string): string[];

export function evaluateMatrix(input: {
  actual: string[];
  declared: Set<string>;
  appearances: Map<string, number>;
  transitions: MatrixTransition[];
  retired: string[];
  hookCount: (name: string) => number;
}): MatrixVerdict;
