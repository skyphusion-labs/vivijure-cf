// Best-effort wall-clock attribution for module workers that reach fleet infrastructure over
// Workers VPC (cf#396).
//
// WHY. cp#288 meters RunPod. Nothing metered the finishing swarm (video-finish, audio-master,
// audio-beat-sync). A hosted consumer using film-titles / subtitle / audio-master / beat-sync would
// spend our boxes with no duration or start time on record. These four modules are bucket D today
// (no TENANT_MODULE_CATALOG row), so this is pre-emptive: the instrument lands before any catalog
// row makes the path live.
//
// WHAT THIS IS. Module-side OBSERVATION only:
//   1. Structured console.log `{ "ev": "vpc.call", ... }` (Loki via vivijure-tail).
//   2. Optional `vpc:elapsed_ms=N` applied tag so film/job applied history carries the wall-clock.
//
// WHAT THIS IS NOT. Full billing, per-tenant spend ledger, or control-plane metering. Those need a
// plane ruling (same breath as cp#288 / cp#284). Absent that ruling we do not invent a billing
// table; we make every fleet VPC call queryable by wall-clock start + duration.
//
// NEVER throws. Telemetry that converted a soft degrade into a hard failure would be worse than
// the gap it closes.

/** Terminal / intermediate outcomes we can observe from the module side. */
export type VpcCallOutcome =
  | "ok" // sync HTTP success (2xx other than async 202)
  | "submitted" // async job accepted (202 + job id)
  | "completed" // async job finished successfully
  | "failed" // async job or container reported failure
  | "error" // non-2xx / non-terminal fault on this hop
  | "unreachable" // transport throw
  | "not_found" // 404 (async route missing, or job lost after restart)
  | "pending"; // async poll, still running (rarely logged; terminal-only by default)

export type VpcCallMode = "sync" | "async_submit" | "async_poll";

export interface VpcCallRecord {
  /** Module worker name, e.g. film-titles. Compile-time constant, never user input. */
  module: string;
  /** Fleet service the binding reaches, e.g. video-finish. */
  service: string;
  /** Binding name for grepping, e.g. VIDEO_FINISH_VPC. */
  binding: string;
  /** Path portion of the absolute VPC URL, e.g. /film-titles or /async/status/<id>. */
  route: string;
  mode: VpcCallMode;
  outcome: VpcCallOutcome;
  /** Wall-clock start of THIS hop (Date.now at fetch begin), epoch ms. */
  startedAtMs: number;
  /** Wall-clock duration of THIS hop in ms. */
  elapsedMs: number;
  /**
   * For async_poll terminal events: wall-clock from the original submit (poll token submittedAt)
   * to this terminal observation. Absent on sync / submit / non-terminal poll.
   */
  jobElapsedMs?: number;
  httpStatus?: number;
  /** Container async job id when known. */
  containerJobId?: string;
  /** Correlation only: film / bed key the module was handed. */
  filmKey?: string;
  project?: string;
  contextJobId?: string;
}

/** Applied-tag prefix so film job history carries wall-clock without inventing a billing column. */
export const VPC_ELAPSED_APPLIED_PREFIX = "vpc:elapsed_ms=";

/** Pure: format the applied tag. Rounds to integer ms; never negative. */
export function vpcElapsedAppliedTag(elapsedMs: number): string {
  const n = Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0;
  return VPC_ELAPSED_APPLIED_PREFIX + n;
}

/** Pure: append the tag once (idempotent if already present). Does not mutate the input array. */
export function withVpcElapsedApplied(applied: string[], elapsedMs: number): string[] {
  const tag = vpcElapsedAppliedTag(elapsedMs);
  if (applied.some((t) => t.startsWith(VPC_ELAPSED_APPLIED_PREFIX))) {
    return applied.map((t) => (t.startsWith(VPC_ELAPSED_APPLIED_PREFIX) ? tag : t));
  }
  return [...applied, tag];
}

/**
 * Emit one structured vpc.call line. Never throws. Sink is console.log so the vivijure-tail ->
 * Loki pipeline carries it (docs/observability.md).
 */
export function logVpcCall(rec: VpcCallRecord): void {
  try {
    const line: Record<string, unknown> = {
      ev: "vpc.call",
      module: rec.module,
      service: rec.service,
      binding: rec.binding,
      route: rec.route,
      mode: rec.mode,
      outcome: rec.outcome,
      started_at_ms: Math.floor(rec.startedAtMs),
      elapsed_ms: Math.max(0, Math.round(rec.elapsedMs)),
    };
    if (typeof rec.jobElapsedMs === "number" && Number.isFinite(rec.jobElapsedMs)) {
      line.job_elapsed_ms = Math.max(0, Math.round(rec.jobElapsedMs));
    }
    if (typeof rec.httpStatus === "number" && Number.isFinite(rec.httpStatus)) {
      line.http_status = rec.httpStatus;
    }
    if (rec.containerJobId) line.container_job_id = rec.containerJobId;
    if (rec.filmKey) line.film_key = rec.filmKey;
    if (rec.project) line.project = rec.project;
    if (rec.contextJobId) line.context_job_id = rec.contextJobId;
    console.log(JSON.stringify(line));
  } catch {
    // Telemetry must never fail the render path.
  }
}

export interface TimedVpcFetchMeta {
  module: string;
  service: string;
  binding: string;
  /** Absolute URL (host is the VPC service name; binding ignores it). */
  url: string;
  mode: VpcCallMode;
  filmKey?: string;
  project?: string;
  contextJobId?: string;
  containerJobId?: string;
  /**
   * Map the response (or throw) onto an outcome. Defaults: throw -> unreachable; 202 -> submitted;
   * 404 -> not_found; 2xx -> ok; else error.
   */
  outcomeFrom?: (resp: Response | null, err: unknown) => VpcCallOutcome;
  /**
   * When set (async terminal poll), also records job_elapsed_ms = now - submittedAtMs.
   * The hop's own elapsed_ms stays the poll RTT.
   */
  submittedAtMs?: number;
  /** Skip logging entirely (e.g. intermediate pending polls). Default false. */
  silent?: boolean;
}

export interface TimedVpcFetchResult {
  resp?: Response;
  err?: unknown;
  startedAtMs: number;
  elapsedMs: number;
  outcome: VpcCallOutcome;
  jobElapsedMs?: number;
}

function defaultOutcome(resp: Response | null, err: unknown): VpcCallOutcome {
  if (err != null || !resp) return "unreachable";
  if (resp.status === 202) return "submitted";
  if (resp.status === 404) return "not_found";
  if (resp.ok) return "ok";
  return "error";
}

function routeOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Time one VPC fetch, log it (unless silent), and return the response or error without throwing.
 * Callers keep their existing control flow; this is pure instrumentation around the hop.
 */
export async function timedVpcFetch(
  fetchFn: (url: RequestInfo, init?: RequestInit) => Promise<Response>,
  init: RequestInit | undefined,
  meta: TimedVpcFetchMeta,
): Promise<TimedVpcFetchResult> {
  const startedAtMs = Date.now();
  let resp: Response | undefined;
  let err: unknown;
  try {
    resp = await fetchFn(meta.url, init);
  } catch (e) {
    err = e;
  }
  const elapsedMs = Date.now() - startedAtMs;
  const outcome = (meta.outcomeFrom ?? defaultOutcome)(resp ?? null, err ?? null);
  const jobElapsedMs =
    typeof meta.submittedAtMs === "number" && Number.isFinite(meta.submittedAtMs) && meta.submittedAtMs > 0
      ? Math.max(0, Date.now() - meta.submittedAtMs)
      : undefined;
  if (!meta.silent) {
    logVpcCall({
      module: meta.module,
      service: meta.service,
      binding: meta.binding,
      route: routeOf(meta.url),
      mode: meta.mode,
      outcome,
      startedAtMs,
      elapsedMs,
      jobElapsedMs,
      httpStatus: resp?.status,
      containerJobId: meta.containerJobId,
      filmKey: meta.filmKey,
      project: meta.project,
      contextJobId: meta.contextJobId,
    });
  }
  return { resp, err, startedAtMs, elapsedMs, outcome, jobElapsedMs };
}

/**
 * Log a terminal async job observation whose wall-clock is measured from the poll token's
 * submittedAt, without wrapping a fetch (caller already has the status body). Never throws.
 */
export function logVpcAsyncTerminal(args: {
  module: string;
  service: string;
  binding: string;
  route: string;
  outcome: Extract<VpcCallOutcome, "completed" | "failed" | "not_found" | "error">;
  submittedAtMs: number;
  pollElapsedMs?: number;
  httpStatus?: number;
  containerJobId?: string;
  filmKey?: string;
  project?: string;
  contextJobId?: string;
  nowMs?: number;
}): number {
  const now = typeof args.nowMs === "number" ? args.nowMs : Date.now();
  const jobElapsedMs =
    typeof args.submittedAtMs === "number" && args.submittedAtMs > 0
      ? Math.max(0, now - args.submittedAtMs)
      : 0;
  logVpcCall({
    module: args.module,
    service: args.service,
    binding: args.binding,
    route: args.route,
    mode: "async_poll",
    outcome: args.outcome,
    startedAtMs: args.submittedAtMs > 0 ? args.submittedAtMs : now,
    elapsedMs: typeof args.pollElapsedMs === "number" ? args.pollElapsedMs : jobElapsedMs,
    jobElapsedMs,
    httpStatus: args.httpStatus,
    containerJobId: args.containerJobId,
    filmKey: args.filmKey,
    project: args.project,
    contextJobId: args.contextJobId,
  });
  return jobElapsedMs;
}
