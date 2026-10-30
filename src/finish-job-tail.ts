// How long a finish container stays awake after its job ends (cf#1064).
//
// A finished job used to keep its instance for the whole 10 minute sleepAfter, so short jobs still
// spent a slot for 10 minutes. Measured 2026-10-30: jobs read done within about two minutes of submit,
// and `Activity expired` landed 10m00s after the last poll (15:27:55 to 15:37:55, 15:44:56 to 15:54:56).
//
// This shortens only the tail. While a job is open the timer stays at RUNNING_SLEEP_AFTER, because
// polls are what keep a running encode awake: nothing renews the timer from inside the job loop (#784).
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

  /** A submit was accepted. Returns "hold" because a job is now running on this instance. */
  submitted(jobId: string): TailDecision {
    this.open.add(jobId);
    return "hold";
  }

  /** A status read returned a terminal state. Returns "release" once no other job is open. */
  terminal(jobId: string): TailDecision {
    this.open.delete(jobId);
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
  let body: { jobId?: unknown; status?: unknown };
  try {
    body = (await resp.clone().json()) as typeof body;
  } catch {
    return null;
  }
  if (submit) return typeof body.jobId === "string" && body.jobId ? tail.submitted(body.jobId) : null;
  return body.status === "completed" || body.status === "failed" ? tail.terminal(statusId as string) : null;
}
