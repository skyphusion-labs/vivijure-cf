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
export const COLD_START_NOTE: string;
export const STALL_NOTE: string;

// cf#303: user-facing label for an internal phase token. null when there is no
// phase at all; unknown phases pass through raw rather than vanishing.
export function phaseLabel(phase: string | null | undefined): string | null;

// cf#303: true while the keyframe phase is underway with no keyframe landed
// yet (the GPU is still starting). False once the server's stall signal fires.
export function isStartupWindow(
  out: RenderProgressOutput | null | undefined,
): boolean;

// cf#303: the server-authored stall verdict already carried in the envelope.
export function isStalled(
  out: RenderProgressOutput | null | undefined,
): boolean;

export function progressFraction(
  out: RenderProgressOutput | null | undefined,
): number | null;

export function remainingMs(
  fraction: number | null | undefined,
  elapsedMs: number,
): number | null;
