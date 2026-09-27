// The video-finish door reached through the FINISH_CONTAINER Durable Object binding (cf#810).
//
// WHY THIS EXISTS, and why it is not a route. cf#797 specified `VIDEO_FINISH_URL` pointing at a
// Worker ROUTE on vivijure-studio, so core's contract would be untouched. That premise is false and
// it was measured, not argued:
//
//   1. @skyphusion-labs/vivijure-core is a LIBRARY that runs INSIDE vivijure-studio, and its
//      mediaDoorFetch was a plain global fetch(url + path). So pointing VIDEO_FINISH_URL at a route
//      on this Worker makes the Worker fetch its own route.
//   2. Cloudflare documents that this FAILS. "Using global fetch() to call another Worker on the
//      same zone without service bindings fails"; "On the same zone, the only way for a Worker to
//      communicate with another Worker running on a route, or on a workers.dev subdomain, is via
//      service bindings." A Custom Domain lifts it -- for ANOTHER Worker. Ours is the same one.
//
// So the door is the BINDING. No hostname, no DNS, no edge hop, no bearer required, and the
// container stays unreachable from the internet -- the property cf#797 itself called not tradeable.
//
// REQUIRES core >= 1.23.0. The seam is `MEDIA_DOOR_FETCHERS` on the env core receives, keyed by the
// door's URL var so there is one door vocabulary rather than two, and duck-typed on `fetch` so a DO
// stub needs no Cloudflare type inside core. Below 1.23.0 core does not read the field and this file
// is INERT: the door is constructed, ignored, and the public-origin path runs unchanged.
//
// NAMING: "finish door" in this repo already means the always-on GPU upscale/blender doors
// (FINISH_UPSCALE_DOORS, tests/finish-door-pool-cf507.test.ts). This is a different thing and is
// deliberately NOT called that. It sits next to video-finish-availability.ts and shares its prefix.

import type { MediaDoorFetcher, MediaDoorFetchers } from "@skyphusion-labs/vivijure-core/media-finish-auth";
import type { Env } from "./env";

export type { MediaDoorFetcher, MediaDoorFetchers };

/** Structural type for reading the door off an env without declaring it in the wrangler binding
 *  mirror in env.ts. It is NOT a binding -- studioEnv() synthesises it -- and env.ts mirrors
 *  wrangler and nothing else. Core declares the same field on its own env type. */
export interface VideoFinishDoorHost {
  MEDIA_DOOR_FETCHERS?: MediaDoorFetchers;
}

/** Read the bound video-finish door off any env, or null. Mirrors core's `mediaDoorFetcher`,
 *  including its duck-type check, so cf and core agree on what counts as bound. */
export function videoFinishDoorOf(env: Partial<VideoFinishDoorHost>): MediaDoorFetcher | null {
  const bound = env.MEDIA_DOOR_FETCHERS?.VIDEO_FINISH_URL;
  return bound && typeof bound.fetch === "function" ? bound : null;
}

/** Instances serving routes that carry NO cross-call state.
 *
 *  ONE, and the reason is the application ceiling, not a preference. `max_instances = 3` in
 *  wrangler.toml.example is a deliberate spend and blast-radius knob (its own comment: the platform
 *  default is 20 and this is "deliberately low to start"), and critically **a request that would
 *  exceed the cap does NOT queue: it fails**. So the pool is not free-running: every name it can
 *  address is one the load-bearing job path cannot have.
 *
 *  HOW THAT FAILURE PRESENTS, measured rather than reasoned (cf#810, film-40e0cd09, 2026-09-27).
 *  An earlier revision of this comment said the over-cap request "ERRORS rather than queueing".
 *  Directionally right, materially misleading about TIMING, and someone would design against it:
 *  the refusal is NOT prompt. Watched live with the pool at 4 against a cap of 3, the job
 *  container was created as a Durable Object and then simply never reached `running`. Core's
 *  `submitAsync` sat on it for minutes instead of getting a fast error, so the film presented as
 *  a HANG in `assemble`, not as a clean failure.
 *
 *  Two consequences worth knowing before anyone widens this constant again:
 *    - Neither of core's assemble guards can fire on this path. `ASSEMBLE_NOTFOUND_STREAK` counts
 *      misses on the POLL, and `ASSEMBLE_MAX_JOB_SECONDS` measures from `submittedAt`; both exist
 *      only AFTER a successful submit. A submit that never succeeds is unguarded.
 *    - `routingKey()` is minted per ATTEMPT, so every retry addresses a DIFFERENT object and
 *      leaves behind another instance record that cannot start. The application's instance list
 *      GROWS while the film is stuck. Watch the list length, not just the pool names.
 *
 *  The arithmetic, which is the whole of it:
 *
 *      SYNC_POOL_SIZE  +  concurrent finish jobs  <=  max_instances
 *              1       +            2             <=        3
 *
 *  I first set this to 4 against a ceiling of 3, which means the pool ALONE could exceed the cap
 *  before a single encode ran. That was measured off the live application (cf#810), not reasoned
 *  out: I had not read `max_instances` because I wrongly believed I held no Cloudflare credential.
 *
 *  THE COST OF 1, NAMED RATHER THAN HIDDEN: a burst of per-clip /inspect calls now serialises
 *  behind a single container. That is worse than a wider pool would be, and it is still correct
 *  here, because the alternative is not a slower sync call, it is an ERROR on the finish job that
 *  the whole tier exists to run. A sync call waiting is a latency cost; a job instance refused is
 *  a film that does not get made.
 *
 *  To widen it, raise `max_instances` FIRST -- that is a spend decision, not this constant's --
 *  then raise this. tests/video-finish-pool-ceiling-cf810.test.ts asserts the inequality above
 *  against the real wrangler.toml.example, so the two numbers cannot drift apart again. */
export const SYNC_POOL_SIZE = 1;

/** Concurrent finish jobs the pool must leave room for. Not a limit we enforce -- it is the headroom
 *  the ceiling test requires, so a future pool widening cannot silently eat the job budget. */
export const RESERVED_JOB_INSTANCES = 2;

/** Separator between the routing key and the container's own job id in the compound id handed
 *  back to core. A container job id is uuid4().hex -- 32 hex characters, no dot -- so one dot is
 *  unambiguous and we split on the FIRST one. */
export const COMPOUND_SEPARATOR = ".";

/** The origin core prefixes onto every bound-path request (MEDIA_DOOR_INTERNAL_ORIGIN in core). The
 *  hostname is a LABEL: nothing resolves it, and it exists only because `fetch` demands an absolute
 *  URL. We parse it off again immediately. */
const CONTAINER_ORIGIN = "http://video-finish";

/** The 202 body app.py returns from POST /async/<route>. */
interface AsyncSubmitBody {
  ok?: boolean;
  jobId?: string;
  status?: string;
}

type FinishNamespace = Env["FINISH_CONTAINER"];

/** Deps seam so the routing can be driven in a plain-node test without a Workers runtime. */
export interface VideoFinishDoorDeps {
  /** 32 hex characters. Injected so a test can assert WHICH instance a call routed to. */
  routingKey: () => string;
  /** Chooses a stateless-pool index in [0, SYNC_POOL_SIZE). */
  poolIndex: () => number;
}

export const productionDoorDeps: VideoFinishDoorDeps = {
  routingKey: () => crypto.randomUUID().replace(/-/g, ""),
  poolIndex: () => Math.floor(Math.random() * SYNC_POOL_SIZE),
};

/** Core hands us an ABSOLUTE url (`http://video-finish/async/status/x`). Everything downstream
 *  reasons about the path, so normalise once, here, and keep the query string: dropping it would
 *  silently discard parameters on any route that grows one. */
export function pathOf(input: string): string {
  try {
    const u = new URL(input, CONTAINER_ORIGIN);
    return u.pathname + u.search;
  } catch {
    return input.startsWith("/") ? input : "/" + input;
  }
}

/** Exported for the test that pins the routing table. Returns the DO instance NAME a status path
 *  maps to, or null when the id carries no routing key. */
export function statusInstanceName(input: string): string | null {
  return splitCompound(input)?.routingKey ?? null;
}

function splitCompound(input: string): { routingKey: string; containerJobId: string } | null {
  const m = /^\/async\/status\/([^?]+)/.exec(pathOf(input));
  if (!m) return null;
  let compound: string;
  try {
    compound = decodeURIComponent(m[1]);
  } catch {
    compound = m[1];
  }
  const i = compound.indexOf(COMPOUND_SEPARATOR);
  // i === 0 means an empty routing key, which cannot address anything.
  if (i <= 0) return null;
  return { routingKey: compound.slice(0, i), containerJobId: compound.slice(i + 1) };
}

/** POST /async/<route>, excluding the status read. This is the call that MINTS a job. */
function isAsyncSubmit(path: string, method: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  return /^\/async\/(?!status\/)[^/?]+(\?.*)?$/.test(path);
}

/**
 * Build the door over a FINISH_CONTAINER namespace.
 *
 * PER-JOB ADDRESSING, which is the whole reason this is not a passthrough. Every container instance
 * sits behind its OWN Durable Object and job state lives in that instance's RAM (`JOBS` in
 * app.py). A poll that lands on a different instance than the encode returns 404, and core reads a
 * 404 as "job gone" rather than "wrong box" -- it reports a running job as vanished. That is the
 * same defect class the GPU door pool hit in cf#507, and it is why `getRandom()` is banned here.
 *
 * NOTE ON WHAT THIS DOES NOT SOLVE: container job state is still process memory (vivijure-cf#784
 * item 2 is open), so a restart or eviction loses a running job even with the poll correctly
 * addressed. Reaching the right box and the job surviving are different problems. Core keeps its
 * not-found streak on the bound path precisely because a 404 can still be transient.
 *
 * The container mints its own `uuid4().hex` job id and we do NOT change that. Instead the submit
 * response is rewritten to a COMPOUND id, `<routingKey>.<containerJobId>`, and the poll splits it
 * back apart. This works only because core treats the job id as fully opaque, which was checked
 * rather than assumed: `submitAsync` accepts any non-empty string and `pollOne` only
 * `encodeURIComponent`s it.
 */
export function videoFinishDoor(
  ns: FinishNamespace,
  deps: VideoFinishDoorDeps = productionDoorDeps,
): MediaDoorFetcher {
  const stub = (name: string) => ns.get(ns.idFromName(name));

  return {
    async fetch(input: string, init: RequestInit = {}): Promise<Response> {
      const p = pathOf(input);
      const method = (init.method as string | undefined) ?? "GET";

      if (isAsyncSubmit(p, method)) {
        const rk = deps.routingKey();
        const resp = await stub(rk).fetch(CONTAINER_ORIGIN + p, init);
        // Anything that is not the documented 202 accept is passed through UNTOUCHED. Rewriting a
        // failure body would invent a job id for a job that does not exist.
        if (resp.status !== 202) return resp;
        let body: AsyncSubmitBody | null = null;
        try {
          body = (await resp.clone().json()) as AsyncSubmitBody;
        } catch {
          return resp;
        }
        if (!body || body.ok !== true || typeof body.jobId !== "string" || !body.jobId) {
          // Same reasoning: no id to make routable, so do not manufacture one. Core reads this as
          // a failed submit, which is the honest outcome.
          return resp;
        }
        const rewritten = { ...body, jobId: rk + COMPOUND_SEPARATOR + body.jobId };
        return new Response(JSON.stringify(rewritten), {
          status: resp.status,
          headers: { "content-type": "application/json" },
        });
      }

      const split = splitCompound(p);
      if (split) {
        return stub(split.routingKey).fetch(
          CONTAINER_ORIGIN + "/async/status/" + encodeURIComponent(split.containerJobId),
          init,
        );
      }

      // A status read whose id carries no routing key cannot be addressed to the instance holding
      // it. Answering 404 here is CORRECT and is what core already handles: it counts not-found
      // against ASSEMBLE_NOTFOUND_STREAK rather than failing the film on the first miss. Guessing
      // an instance would be worse than admitting we cannot route -- it would poll a container that
      // never ran this job and report the job gone.
      if (/^\/async\/status\//.test(p)) {
        return new Response(JSON.stringify({ ok: false, status: "not_found", error: "unroutable job id" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // Stateless routes: /finish, /inspect, /frames, /film-titles, /subtitle, /health. No affinity
      // is required because nothing is carried between calls.
      return stub("sync-" + deps.poolIndex()).fetch(CONTAINER_ORIGIN + p, init);
    },
  };
}
