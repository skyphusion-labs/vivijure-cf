// Types for the cross-page module registry in module-registry.js (cf#580). Hand-authored, because
// the project has no build step, so tests/modules-fetch-memo-580.test.ts typechecks under the CI tsc
// gate. Runtime stays plain vanilla JS.

// The GET /api/modules projection, as far as this memo cares. Deliberately loose: the memo neither
// validates nor reshapes the payload, it only shares one request for it, so narrowing here would
// invent a contract this file does not enforce. The contract itself is vivijure-core owned.
export interface ModuleRegistryPayload {
  modules?: unknown[];
  hooks?: Record<string, unknown>;
  catalog?: unknown[];
  host?: Record<string, unknown>;
  render?: unknown;
  api?: string;
  [key: string]: unknown;
}

export type RegistryTransport = (url: string) => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}>;

// Shared one-flight memo. NEVER rejects: a non-ok response or a transport throw resolves the
// documented empty shape and raises registryUnavailable(). It CAN throw synchronously, and only for
// one reason: no transport is bound (no window at eval and setTransport() never called). That throw
// is deliberate, a silent fallback there would re-issue the un-memoised request this file removes.
export function load(): Promise<ModuleRegistryPayload>;

// Whatever load() last resolved, or null before it resolves. For synchronous helpers reading the
// projection after their own await; never a substitute for awaiting load().
export function cached(): ModuleRegistryPayload | null;

// cf#344. True only when a load COMPLETED and could not deliver the projection. False before any
// load and false on a successful one, so a caller must await load() first.
export function registryUnavailable(): boolean;

// The status line or transport message behind a failure ("/api/modules -> 503"); empty string when
// there was none. For the callers that show a reader a reason rather than degrading quietly.
export function registryFailureReason(): string;

// Explicit transport injection: the test seam, and the only supported way to drive this outside a
// browser.
export function setTransport(fn: RegistryTransport | null): void;

// TEST SEAM ONLY. Clearing the memo inside a page re-opens the per-page fan-out this file closes.
export function reset(): void;
