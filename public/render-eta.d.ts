// Types for the pure render-ETA helpers in render-eta.js. Hand-authored (the
// project has no build step) so tests/render-eta.test.ts typechecks under the
// CI tsc gate. Runtime stays plain vanilla JS.

export interface PipelinePhaseBand {
  key: string;
  start: number;
  span: number;
}

// A status-poll output envelope (data.output from GET
// /api/storyboard/render/:jobId). Every field is optional / best-effort.
export interface RenderProgressOutput {
  phase?: string;
  progress?: number;
  scene_index?: number;
  scene_total?: number;
  log?: unknown[];
  // cf#303: server-authored stall verdict from core stallSignal(). Present
  // only once the phase has not advanced past KEYFRAME_STALL_SECONDS.
  stalled?: boolean;
  stall_seconds?: number;
  last_progress_at?: number;
  [k: string]: unknown;
}

export const PIPELINE_PHASES: PipelinePhaseBand[];
export const MIN_FRACTION_FOR_ETA: number;
export const MIN_ELAPSED_MS_FOR_ETA: number;
export const PHASE_LABELS: Record<string, string>;
export const STATUS_LABELS: Record<string, string>;
export const COLD_START_NOTE: string;
export const STALL_NOTE: string;

// A status-poll envelope (GET /api/storyboard/render/:jobId), or the
// nested output bag. isColdStart / waitCopy accept either so a test can
// pass the real poll shape (status + delayTimeMs + output).
export interface RenderPollView {
  status?: string;
  statusRaw?: string;
  delayTimeMs?: number;
  delayTime?: number;
  stalled?: boolean;
  output?: RenderProgressOutput | null;
  phase?: string;
  progress?: number;
  scene_index?: number;
  scene_total?: number;
  backend_wait?: "accepted" | "running" | string;
  [k: string]: unknown;
}

// cf#303: user-facing label for an internal phase token. null when there is no
// phase at all; unknown phases pass through raw rather than vanishing.
export function phaseLabel(phase: string | null | undefined): string | null;

// cf#303: filmmaker-facing status words. IN_QUEUE -> "Starting up". Unknown
// tokens pass through raw. null when there is no status.
export function statusLabel(status: string | null | undefined): string | null;

// cf#303: true while the door reports a live cold start (IN_QUEUE /
// delayTime / backend_wait=accepted), or, with no status field, while the
// keyframe phase is underway with nothing drawn. False for a running encode
// and once the server's stall signal fires.
export function isStartupWindow(
  poll: RenderPollView | RenderProgressOutput | null | undefined,
): boolean;

// cf#303: true only on the observed queue signal (IN_QUEUE, SUBMITTED,
// backend_wait=accepted, or delayTime not attached to IN_PROGRESS).
export function isColdStart(
  poll: RenderPollView | RenderProgressOutput | null | undefined,
): boolean;

// cf#303: the server-authored stall verdict already carried in the envelope.
export function isStalled(
  poll: RenderPollView | RenderProgressOutput | null | undefined,
): boolean;

// cf#303: the live-panel note. STALL_NOTE, COLD_START_NOTE, or null.
export function waitCopy(
  poll: RenderPollView | RenderProgressOutput | null | undefined,
): string | null;

export function progressFraction(
  out: RenderProgressOutput | null | undefined,
): number | null;

export function remainingMs(
  fraction: number | null | undefined,
  elapsedMs: number,
): number | null;
