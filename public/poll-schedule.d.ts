// Types for the pure poll-scheduling policy in poll-schedule.js. Hand-authored
// (the project has no build step) so tests/poll-schedule-515.test.ts
// typechecks under the CI tsc gate. Runtime stays plain vanilla JS.

export interface NextPollDelayOptions {
  // Base cadence to jitter around. Defaults to POLL_BASE_MS.
  baseMs?: number;
  // Consecutive poll failures so far. 0 (or absent) means no backoff. Values
  // are floored and clamped internally, so a pathological streak cannot
  // produce Infinity and hand NaN to setTimeout.
  errorStreak?: number;
  // Injected for tests. Defaults to Math.random. The whole point of the
  // injection is that the jitter is reachable from a node test with no DOM.
  random?: () => number;
}

export interface ArmPollOptions extends NextPollDelayOptions {
  // When true, armPoll arms NOTHING and returns null. It deliberately does not
  // arm a longer timer: a hidden tab should cost the studio zero, which is
  // what lets a load run shed load rather than only add it.
  hidden?: boolean;
  // The poll function to schedule.
  run: () => void;
  // Injected for tests. Defaults to the global setTimeout.
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export const POLL_BASE_MS: number;
export const JITTER_MIN_FACTOR: number;
export const JITTER_SPAN: number;
export const BACKOFF_FACTOR: number;
export const BACKOFF_MAX_MS: number;

export function nextPollDelayMs(opts?: NextPollDelayOptions): number;

// Returns the timer handle, or null when it refused because the tab is hidden.
export function armPoll(opts: ArmPollOptions): unknown;
