// FinishContainer: the Durable Object that fronts the video-finish Cloudflare Container.
//
// Paired 1:1 with the [[containers]] and [[durable_objects.bindings]] blocks in
// wrangler.toml.example (class_name "FinishContainer", binding FINISH_CONTAINER) and with
// FINISH_CONTAINER in src/env.ts. All four move together: `wrangler deploy` REJECTS a Durable
// Object binding whose class is not exported from the entrypoint, so declaring the binding
// without exporting the class arms a deploy failure that only fires at the next `v*` tag, in
// studio-release.yml's `wrangler deploy --dry-run` bundle step. That takes the whole studio
// release down, and it lands on whoever tags next for an unrelated reason. Do not split them.
//
// This class is deliberately MINIMAL. The base `Container.fetch()` already forwards the request
// to the container on `defaultPort`, so a passthrough needs no code of our own, and the finish
// tier's own HTTP surface (/async/finish, /async/status/{jobId}, /finish, /inspect) is unchanged.
// cf#784: job state is still the container's process memory, so a restart loses a running job. That
// loss is now DETECTED here: the container names its process on every async body, and a not_found from a
// different process than took the 202 is logged as `finish_container.job_lost` and marked on the 404.
// Keeping a job alive across a restart (externalised state) is still open.

import { Container } from "@cloudflare/containers";
import type { Env } from "./env";
import { FinishJobTail, JOB_LOST_REASON, RELEASE_SLEEP_AFTER, RUNNING_SLEEP_AFTER, lostToRestart, observeExchange, statusJobId } from "./finish-job-tail";
import { FinishJobRecords, expiryVerdict, probeStatusOf, recordedStatusBody, type ProbeStatus, type RecordStorage } from "./finish-job-record";
import { mediaFinishToken } from "../modules/_shared/media-finish-auth";

// THE BEARER CONFIGURATION THIS CONTAINER IS STARTED WITH (cf#911, stage 2). Exported as a literal
// because tests/container-bearer-gate.test.py parses it and drives the real Python gate with it.

/** The variable the container reads its token from. The VALUE comes from MEDIA_FINISH_TOKEN, the
 *  same Secrets Store binding the Worker sends, so the two sides cannot disagree. It is the ONLY
 *  bearer variable this container is ever given: no permit, no opt-out. */
export const FINISH_CONTAINER_TOKEN_VAR = "LOCAL_FINISH_TOKEN";

export type FinishContainerBearer = { mode: "token"; vars: Record<string, string> } | { mode: "none" };

/** Resolve the container's bearer env from the Worker env. Never logs or returns the token outside
 *  `vars`, which goes only to the container's start config. */
export async function finishContainerBearer(env: Pick<Env, "MEDIA_FINISH_TOKEN">): Promise<FinishContainerBearer> {
  const token = await mediaFinishToken(env.MEDIA_FINISH_TOKEN);
  return token ? { mode: "token", vars: { [FINISH_CONTAINER_TOKEN_VAR]: token } } : { mode: "none" };
}

/** What the Durable Object answers, WITHOUT starting the container, when no token is readable. */
export const FINISH_CONTAINER_NO_TOKEN_STATUS = 503;

/** True for a request the container would gate (every path but its health probe) that carries no
 *  Authorization header. Counted at the Durable Object, where the Worker's own log can see it. */
export function bearerAbsent(request: Request): boolean {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  return path !== "/health" && !request.headers.has("authorization");
}

/** cf#784: does this request carry exactly `Bearer <token>`? Constant-time over the token bytes. */
export function bearerMatches(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const got = request.headers.get("authorization") ?? "";
  const want = `Bearer ${token}`;
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(want);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

export class FinishContainer extends Container<Env> {
  // containers/video-finish/Dockerfile sets ENV PORT=8000 and app.py binds 0.0.0.0:8000.
  defaultPort = 8000;

  // cf#893 made the container REFUSE TO START without a bearer configuration, and NOTHING reaches
  // this container's process except `envVars`: it defaults to `{}` in the base class, the
  // [[containers]] block carries no env, and the Dockerfile sets none.
  //
  // cf#911: THE BOUND HOP CARRIES THE TOKEN AND THE CONTAINER REQUIRES IT (stage 2 of 2). The
  // binding is a private boundary, but that is a property of the deployment and nothing in the code
  // keeps it so; the container checks the credential anyway.
  //
  // The first fetch resolves MEDIA_FINISH_TOKEN and starts the container with it alone. A missing
  // or wrong header is 401 from the container. With no readable token this object answers 503 and
  // never starts the container, and logs `finish_container.no_token`: there is no opt-out left.
  // `finish_container.bearer_absent` is still logged, because now it predicts a 401.
  //
  // `{}` until the first fetch resolves the token. Only fetch() starts this container; a start by any
  // other path would get `{}`, and the container refuses to start without a token: fail closed.
  envVars: Record<string, string> = {};

  private bearerReady?: Promise<FinishContainerBearer>;

  // sleepAfter is the IDLE timeout, and for this stage it is a contract with the job loop, not a
  // free knob.
  //
  // Why it is not short: /async/finish returns immediately, so NO request is in flight while the
  // encode runs. Incoming requests reset this timer automatically; background work does not. So
  // when the timer runs out, onActivityExpired below asks the container about every open job and
  // holds the instance while one is still running (#784, src/finish-job-record.ts). Without that the
  // container sleeps under its own running job, and because container disk is ephemeral and reset to
  // the image on wake, the work dir dies with it and the next poll finds nothing. A 30-60s value
  // (which fleet-chezmoi#2234 recommended for one-shot stages, and which was my error) would
  // make that near-certain.
  //
  // The value below is the timer WHILE A JOB CAN BE RUNNING. Once core has read a terminal status it
  // drops to RELEASE_SLEEP_AFTER, so a finished job does not spend a slot for the whole 10 minutes
  // (cf#1064, src/finish-job-tail.ts holds the measurements).
  //
  // Why it is not huge either. Memory and disk bill on PROVISIONED size for the whole time an
  // instance is awake, and standard-4 provisions 12 GiB. At the published rates that idle tail is
  // about 12 * 600 * 0.0000025 = USD 0.018 in memory plus USD 0.0008 in disk per wake, which is
  // already the same order as the active cost of a 300-second assemble. Every extra minute here
  // is paid on every render and buys nothing, because these jobs are one-shot and never need to
  // stay warm between films.
  //
  // The hold is checked once per expiry, so a running job is asked about every 10 minutes, and a
  // hold ends at core's phase deadline (FINISH_JOB_HOLD_MAX_MS) even if the job never reports.
  sleepAfter: string = RUNNING_SLEEP_AFTER;

  private jobTail = new FinishJobTail();

  /** Resolve the bearer env once per instance, before the first request can start the container. */
  private ensureBearer(): Promise<FinishContainerBearer> {
    this.bearerReady ??= finishContainerBearer(this.env).then((b) => {
      if (b.mode === "token") this.envVars = b.vars;
      console.log(JSON.stringify({ ev: "finish_container.bearer_mode", mode: b.mode, stage: 2 }));
      return b;
    });
    return this.bearerReady;
  }

  /** cf#784: terminal answers this object has seen, in Durable Object storage. */
  private get jobRecords(): FinishJobRecords {
    this.records ??= new FinishJobRecords((this as unknown as { ctx: { storage: RecordStorage } }).ctx.storage);
    return this.records;
  }
  private records?: FinishJobRecords;

  /**
   * cf#784: the idle timer ran out. Ask the container about every job this object saw accepted and has
   * not seen finish, and hold the instance awake while one is still running (src/finish-job-record.ts).
   * Returning without stopping is the hold: the base class renews the timer after this returns.
   */
  override async onActivityExpired(): Promise<void> {
    const open = this.jobTail.openJobs();
    if (open.length) {
      const probes = new Map<string, ProbeStatus>();
      for (const jobId of open) probes.set(jobId, await this.probeJob(jobId));
      const verdict = expiryVerdict(this.jobTail, probes, Date.now());
      console.log(JSON.stringify({ ev: "finish_container.expiry", verdict, probes: Object.fromEntries(probes) }));
      if (verdict === "hold") return;
    }
    await super.onActivityExpired();
  }

  private async probeJob(jobId: string): Promise<ProbeStatus> {
    const token = this.envVars[FINISH_CONTAINER_TOKEN_VAR];
    try {
      const resp = await this.containerFetch(
        new Request(`http://video-finish/async/status/${encodeURIComponent(jobId)}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        }),
      );
      const { status, body } = await probeStatusOf(resp);
      if (status === "terminal" && body) await this.jobRecords.recordBody(jobId, body);
      return status;
    } catch {
      return "unknown";
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const bearer = await this.ensureBearer();
    if (bearer.mode === "none") {
      console.error(JSON.stringify({ ev: "finish_container.no_token", method: request.method, path: new URL(request.url).pathname }));
      return new Response(
        JSON.stringify({ ok: false, error: "finish container not configured: MEDIA_FINISH_TOKEN is not readable" }),
        { status: FINISH_CONTAINER_NO_TOKEN_STATUS, headers: { "content-type": "application/json" } },
      );
    }
    if (bearerAbsent(request)) {
      console.warn(JSON.stringify({ ev: "finish_container.bearer_absent", method: request.method, path: new URL(request.url).pathname }));
    }
    // cf#784: a finished job this object recorded is answered here, before the container is reached, so
    // the answer survives a container restart or sleep and a poll never wakes a container to hear 404.
    // Only for the same bearer the container requires; any other request goes on to the container,
    // which refuses it exactly as before.
    const recordedId = statusJobId(request.method, new URL(request.url).pathname);
    if (recordedId && bearerMatches(request, bearer.vars[FINISH_CONTAINER_TOKEN_VAR])) {
      const rec = await this.jobRecords.get(recordedId);
      if (rec) {
        if (this.jobTail.terminal(recordedId) === "release") {
          this.sleepAfter = RELEASE_SLEEP_AFTER;
          this.renewActivityTimeout();
        }
        return new Response(JSON.stringify(recordedStatusBody(rec)), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    const resp = await super.fetch(request);
    const path = new URL(request.url).pathname;
    const statusId = resp.ok ? statusJobId(request.method, path) : null;
    if (statusId) {
      try {
        await this.jobRecords.recordBody(statusId, (await resp.clone().json()) as Record<string, unknown>);
      } catch { /* an unreadable body records nothing; the container answer still goes back */ }
    }
    const decision = await observeExchange(this.jobTail, request.method, path, resp);
    if (decision) {
      this.sleepAfter = decision === "release" ? RELEASE_SLEEP_AFTER : RUNNING_SLEEP_AFTER;
      this.renewActivityTimeout();
    }
    // cf#784: a job lost to a container restart is said so, in the log and on the 404 itself.
    const lost = await lostToRestart(this.jobTail, request.method, path, resp);
    if (lost) return markLost(this.jobTail, lost, resp);
    return resp;
  }
}

/** cf#784: log a job lost to a restart and return its 404 with `lost` added. Same status, so core's
 *  reading is unchanged; the mark is for anything that reads the body or the tail channel. */
export async function markLost(tail: FinishJobTail, lost: { jobId: string; acceptedBy: string; answeredBy: string }, resp: Response): Promise<Response> {
  tail.lost(lost.jobId);
  console.warn(JSON.stringify({ ev: "finish_container.job_lost", job_id: lost.jobId, accepted_by: lost.acceptedBy, answered_by: lost.answeredBy, reason: JOB_LOST_REASON }));
  let body: Record<string, unknown> = {};
  try {
    body = (await resp.clone().json()) as Record<string, unknown>;
  } catch {
    /* lostToRestart already read it, so this does not happen; an empty body is still a 404 */
  }
  return new Response(JSON.stringify({ ...body, lost: JOB_LOST_REASON }), {
    status: resp.status,
    headers: { "content-type": "application/json" },
  });
}
