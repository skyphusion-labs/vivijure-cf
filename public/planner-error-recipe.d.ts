// Types for the pure helpers in planner-error-recipe.js (cf#649).
// Hand-authored (no build step) so tests typecheck under the CI tsc gate.

export type ErrorRecipeKind = "keyframes" | "flagged" | "unknown";

export interface ErrorRecipe {
  kind: ErrorRecipeKind;
  /** One-sentence next step. Never a raw JSON blob. */
  message: string;
  /** Original provider text, shown behind a fold. Empty string when nothing was given. */
  raw: string;
}

export const KEYFRAMES_MSG: string;
export const FLAGGED_MSG: string;
export const UNKNOWN_MSG: string;

export function stringifyError(raw: unknown): string;
export function classifyError(text: string | null | undefined): ErrorRecipeKind;
export function firstHumanLine(text: string | null | undefined): string;
export function recipeFromError(raw: unknown): ErrorRecipe;
