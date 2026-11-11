// How long a finish container stays awake after its job ends (cf#1064).
//
// A finished job used to keep its instance for the whole 10 minute sleepAfter, so short jobs still
// spent a slot for 10 minutes. Measured 2026-10-30: jobs read done within about two minutes of submit,
// and `Activity expired` landed 10m00s after the last poll (15:27:55 to 15:37:55, 15:44:56 to 15:54:56).
//
// This shortens only the tail. While a job is open the timer stays at RUNNING_SLEEP_AFTER. Polls renew it,
// and when it runs out the Durable Object asks the container and holds a running job awake (#784).
//
// WHY THE TAIL IS NOT ZERO. Job state is process memory. Core reads the terminal status and then writes
// its job doc, so if that write is lost, the next tick polls again and has to find the job. The tail must
// outlast the gap between ticks. Measured across 132 sweeps on 2026-10-30: p50 60s, p95 95s, max 222s.
// So 5 minutes clears the worst reading, with margin.
//
// EVICTION IS SAFE. This state is in memory, and a new Durable Object starts with no open jobs and with
// the class default, which is the long timer. A tail that is too short is the failure to avoid, and the
// tail is also longer than any measured poll gap, so a job this tracker lost still survives its polls.

export const RUNNING_SLEEP_AFTER = "10m";
export const RELEASE_SLEEP_AFTER = "5m";

export type TailDecision = "hold" | "release" | null;

/** Reads requests and responses as they pass through the Durable Object. Pure, so it runs in plain node. */
export class FinishJobTail {
  private readonly open = new Set<string>();
  /** cf#784: the container process that accepted each open job (its `instance` from the 202). */
  private readonly acceptedOn = new Map<string, string>();
  /** cf#784: when each open job was accepted, so a hold past core's phase deadline is not kept. */
  private readonly opened = new Map<string, number>();

  /** A submit was accepted. Returns "hold" because a job is now running on this instance. */
  submitted(jobId: string, instance?: string, now = Date.now()): TailDecision {
    this.open.add(jobId);
    if (!this.opened.has(jobId)) this.opened.set(jobId, now);
    if (instance) this.acceptedOn.set(jobId, instance);
    return "hold";
  }

  /** cf#784: the jobs accepted here and not yet seen to finish. */
  openJobs(): string[] {
    return [...this.open];
  }

  /** cf#784: when this open job was accepted, if this tracker saw the submit. */
  openedAt(jobId: string): number | undefined {
    return this.opened.get(jobId);
  }

  /** cf#784: which container process accepted this job, if this tracker saw the submit. */
  acceptedBy(jobId: string): string | undefined {
    return this.acceptedOn.get(jobId);
  }

  /** cf#784: a job the container lost. It will not reach a terminal status, so stop tracking it. */
  lost(jobId: string): void {
    this.open.delete(jobId);
    this.acceptedOn.delete(jobId);
    this.opened.delete(jobId);
  }

  /** A status read returned a terminal state. Returns "release" once no other job is open. */
  terminal(jobId: string): TailDecision {
    this.open.delete(jobId);
    this.acceptedOn.delete(jobId);
    this.opened.delete(jobId);
    return this.open.size === 0 ? "release" : null;
  }
}

/** POST /async/<route>, excluding the status read. */
export function isSubmitPath(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && /^\/async\/(?!status\/)[^/]+$/.test(path);
}

/** The job id out of GET /async/status/<id>, or null. */
export function statusJobId(method: string, path: string): string | null {
  if (method.toUpperCase() !== "GET") return null;
  const m = /^\/async\/status\/([^/]+)$/.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Decide from one exchange. Never throws: an unreadable body leaves the timer as it is, on the long side. */
export async function observeExchange(
  tail: FinishJobTail,
  method: string,
  path: string,
  resp: Response,
): Promise<TailDecision> {
  const submit = isSubmitPath(method, path) && resp.status === 202;
  const statusId = resp.ok ? statusJobId(method, path) : null;
  if (!submit && !statusId) return null;
  let body: { jobId?: unknown; status?: unknown; instance?: unknown };
  try {
    body = (await resp.clone().json()) as typeof body;
  } catch {
    return null;
  }
  if (submit) {
    if (typeof body.jobId !== "string" || !body.jobId) return null;
    return tail.submitted(body.jobId, typeof body.instance === "string" && body.instance ? body.instance : undefined);
  }
  return body.status === "completed" || body.status === "failed" ? tail.terminal(statusId as string) : null;
}

/** cf#784: a status read the container answered not_found, from a different process than accepted it. */
export interface LostJob {
  jobId: string;
  acceptedBy: string;
  answeredBy: string;
}

/**
 * cf#784: was this job LOST TO A CONTAINER RESTART?
 *
 * Job state is the container's process memory, so a restart (OOM, host restart, a wake after sleep)
 * drops every running job, and the next status read answers 404 `not_found`. That used to be the same
 * 404 as a job the container never had, so core can only debounce it (its not-found streak) and nobody
 * can count how often it happens. The container now names its process (`instance`, minted at start) on
 * every async body. A not_found from a different instance than the one that took the 202 is a restart,
 * and this says so.
 *
 * Returns null, and claims nothing, whenever it cannot know: no recorded submit (this Durable Object
 * was evicted, or the submit predates this change), an old container that sends no `instance`, the
 * same instance answering (the job never existed here, or was reaped), or an unreadable body.
 */
export async function lostToRestart(
  tail: FinishJobTail,
  method: string,
  path: string,
  resp: Response,
): Promise<LostJob | null> {
  if (resp.status !== 404) return null;
  const jobId = statusJobId(method, path);
  if (!jobId) return null;
  const acceptedBy = tail.acceptedBy(jobId);
  if (!acceptedBy) return null;
  let body: { status?: unknown; instance?: unknown };
  try {
    body = (await resp.clone().json()) as typeof body;
  } catch {
    return null;
  }
  if (body.status !== "not_found" || typeof body.instance !== "string" || !body.instance) return null;
  if (body.instance === acceptedBy) return null;
  return { jobId, acceptedBy, answeredBy: body.instance };
}

/** The structured mark a lost job's 404 carries. Core reads only the status code, which is unchanged. */
export const JOB_LOST_REASON = "instance_restarted";
