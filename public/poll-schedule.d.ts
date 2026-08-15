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

// cf#581 / cf#573: the lifecycle half. A loop owns its timer, error streak and
// paused flag, and registers with the ONE visibilitychange listener the module
// attaches per document, so pause and resume are properties of the mechanism
// rather than of whoever remembered to wire them.
export interface CreateLoopOptions {
  // The poll body. It is expected to re-arm itself via armAfterSuccess /
  // armAfterError, exactly as the existing loops already do.
  run: () => void;
  // Base cadence to jitter around. Defaults to POLL_BASE_MS.
  baseMs?: number;
  // REQUIRED, not defaulted. Resume must not restart a loop whose job finished
  // while the tab was hidden, and only the caller knows whether one is in
  // flight. A default of "always active" is the silent-fallback shape that
  // reads as working.
  isActive: () => boolean;
  // Injected so the resume path is testable with no DOM. Defaults to the global
  // document, or null when there is not one.
  doc?: DocumentLike | null;
  // Injected for tests. Default to the global timer functions.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  // Opt-in attempt cap. Backoff bounds the RATE; only a cap bounds the TOTAL.
  // 0 or absent means no cap. cf#573: the regen loop re-armed on its catch path
  // forever against a persistently failing route.
  maxErrorStreak?: number;
  // Called once when the cap is reached and the loop has unregistered itself.
  onGiveUp?: (errorStreak: number) => void;
}

// The subset of Document the loop touches. Deliberately minimal so a test can
// pass a plain object.
export interface DocumentLike {
  hidden?: boolean;
  addEventListener?: (type: string, fn: () => void) => void;
}

export interface LoopState {
  armed: boolean;
  paused: boolean;
  errorStreak: number;
  gaveUp: boolean;
}

export interface PollLoop {
  doc: DocumentLike | null;
  // Arm the next tick. null means nothing was armed, which has TWO causes that
  // are not the same state: hidden (paused, resumable) or inactive (finished).
  // state() distinguishes them; an absence check cannot.
  arm(): unknown;
  armAfterError(): unknown;
  armAfterSuccess(): unknown;
  // Returns true when the loop was marked paused (job still in flight).
  pause(): boolean;
  // Returns true when it actually resumed, so a test can assert the RESUME and
  // not merely the absence of a poll. cf#581 names that as the assertion that
  // matters.
  resume(): boolean;
  // The job finished: clears the timer, the backoff and the paused flag, but KEEPS
  // registration so the same loop object can be re-armed for the next job of the
  // same kind. isActive() is what makes a stopped loop inert.
  stop(): void;
  // Tear down for good and unregister. For loops created per job rather than per
  // pane, so the registry does not grow without bound over a long session.
  destroy(): void;
  state(): LoopState;
}

export function createLoop(opts: CreateLoopOptions): PollLoop;

// Test seam: how many loops are registered against a document. Lets a test
// prove stop() actually unregisters, which is the difference between a loop
// that cannot be resumed and one that merely was not.
export function registeredLoopCount(doc: DocumentLike | null): number;
