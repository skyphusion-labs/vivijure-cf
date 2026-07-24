// Types for the pure helpers in hook-availability-checks.js (cf#98).
// Hand-authored (no build step) so tests typecheck under the CI tsc gate.

export interface HookUnavailableEntry {
  hook: string;
  reason: string;
}

export interface ModulesHostBlock {
  dispatch?: boolean;
  readonly?: boolean;
  /** { "<hook>": "<operator-readable reason>" }, reported by the core about ITSELF. */
  hooks_unavailable?: Record<string, string> | null;
}

export interface ModulesPayload {
  modules?: unknown[];
  hooks?: Record<string, string[]>;
  catalog?: unknown[];
  host?: ModulesHostBlock | null;
}

export const NO_REASON: string;
export function unavailableHooks(payload: ModulesPayload | null | undefined): Record<string, string>;
export function isUnavailable(
  map: Record<string, string> | null | undefined,
  hook: string | null | undefined,
): boolean;
export function reasonFor(
  map: Record<string, string> | null | undefined,
  hook: string | null | undefined,
): string | null;
export function unavailableList(
  map: Record<string, string> | null | undefined,
): HookUnavailableEntry[];
