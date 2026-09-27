// The video-finish door reached through the FINISH_CONTAINER Durable Object binding (cf#810).
//
// WHY THIS EXISTS, and why it is not a route. cf#797 specified `VIDEO_FINISH_URL` pointing at a
// Worker ROUTE on vivijure-studio, so core's contract would be untouched. That premise is false and
// it was measured, not argued:
//
//   1. @skyphusion-labs/vivijure-core is a LIBRARY that runs INSIDE vivijure-studio, and its
//      mediaDoorFetch is a plain global fetch(url + path). There is no fetcher seam. So pointing
//      VIDEO_FINISH_URL at a route on this Worker makes the Worker fetch its own route.
//   2. Cloudflare documents that this FAILS. "Using global fetch() to call another Worker on the
//      same zone without service bindings fails"; "On the same zone, the only way for a Worker to
//      communicate with another Worker running on a route, or on a workers.dev subdomain, is via
//      service bindings." A Custom Domain lifts it -- for ANOTHER Worker. Ours is the same one.
//
// So the door is the BINDING. No hostname, no DNS, no edge hop, no bearer, and the container stays
// unreachable from the internet -- the property cf#797 itself called not tradeable. This is the
// shape src/render-frames.ts already uses (a FetcherLike over `http://video-finish/...`); we are
// adopting the pattern this repo already chose, not inventing one.
//
// NAMING: "finish door" in this repo already means the always-on GPU upscale/blender doors
// (FINISH_UPSCALE_DOORS, tests/finish-door-pool-cf507.test.ts). This is a different thing and is
// deliberately NOT called that. It sits next to video-finish-availability.ts and shares its prefix.

import type { Env } from "./env";

/** A door reached through a BINDING rather than a public origin. The caller passes a PATH, never a
 *  URL; the implementor owns routing. Mirrors the seam vivijure-core takes on env (cf#810). */
export interface MediaDoorFetcher {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** Structural type for reading the door off an env without declaring it in the wrangler binding
 *  mirror in env.ts. It is NOT a binding -- studioEnv() attaches it -- and env.ts mirrors wrangler
 *  and nothing else. */
export interface VideoFinishDoorHost {
  VIDEO_FINISH_DOOR?: MediaDoorFetcher;
}

/** Instances serving routes that carry NO cross-call state. Bounded on purpose, and neither of the
 *  two obvious alternatives: ONE shared instance serialises a burst of per-clip /inspect calls
 *  behind a single container, and a fresh instance per call spawns a container per call, which is
 *  billed per wake. Four is a pool, not a tuned number; raise it when a measurement asks. */
export const SYNC_POOL_SIZE = 4;

/** Separator between the routing key and the container's own job id in the compound id handed
 *  back to core. A container job id is uuid4().hex -- 32 hex characters, no dot -- so one dot is
 *  unambiguous and we split on the FIRST one. */
export const COMPOUND_SEPARATOR = ".";

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

/** Exported for the test that pins the routing table. Returns the DO instance NAME a path maps to,
 *  or null when the path is a submit (whose name is minted fresh) or an unroutable status. */
export function statusInstanceName(path: string): string | null {
  const m = /^\/async\/status\/(.+)$/.exec(path);
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
  return compound.slice(0, i);
}

function containerJobId(path: string): string | null {
  const m = /^\/async\/status\/(.+)$/.exec(path);
  if (!m) return null;
  let compound: string;
  try {
    compound = decodeURIComponent(m[1]);
  } catch {
    compound = m[1];
  }
  const i = compound.indexOf(COMPOUND_SEPARATOR);
  if (i <= 0) return null;
  return compound.slice(i + 1);
}

/** POST /async/<route>, excluding the status read. This is the call that MINTS a job. */
function isAsyncSubmit(path: string, method: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  return /^\/async\/(?!status\/)[^/]+$/.test(path);
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
 * The container mints its own `uuid4().hex` job id and we do NOT change that (cf#810 point 5).
 * Instead the submit response is rewritten to a COMPOUND id, `<routingKey>.<containerJobId>`, and
 * the poll splits it back apart. This works only because core treats the job id as fully opaque,
 * which was checked rather than assumed: `submitAsync` accepts any non-empty string and `pollOne`
 * only `encodeURIComponent`s it.
 */
export function videoFinishDoor(
  ns: FinishNamespace,
  deps: VideoFinishDoorDeps = productionDoorDeps,
): MediaDoorFetcher {
  const stub = (name: string) => ns.get(ns.idFromName(name));

  return {
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const p = path.startsWith("/") ? path : "/" + path;
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

      const name = statusInstanceName(p);
      if (name) {
        const cjid = containerJobId(p);
        // cjid is non-null whenever name is, but narrow rather than assert.
        const tail = cjid ? "/async/status/" + encodeURIComponent(cjid) : p;
        return stub(name).fetch(CONTAINER_ORIGIN + tail, init);
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
      const idx = deps.poolIndex();
      return stub("sync-" + idx).fetch(CONTAINER_ORIGIN + p, init);
    },
  };
}
