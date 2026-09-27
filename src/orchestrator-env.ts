import {
  orchestratorContextFromPlatform,
  type OrchestratorEnv,
  type R2Bucket as CoreR2Bucket,
  type Database as CoreDatabase,
} from "@skyphusion-labs/vivijure-core/platform";
import { meteredR2Bucket } from "@skyphusion-labs/vivijure-core/storage-quota";
import { cfPlatformFromEnv } from "./platform/cf-platform.js";
import { videoFinishDoor, type VideoFinishDoorHost } from "./video-finish-binding.js";
import type { Env } from "./env.js";

/** Platform ICD env for orchestration (PRESIGNER + wrapped R2). */
export function orchestratorEnv(env: Env): OrchestratorEnv {
  return orchestratorContextFromPlatform(cfPlatformFromEnv(env));
}

/** Workers Env merged with orchestration fields for route handlers.
 *
 *  VIDEO_FINISH_DOOR is NOT a wrangler binding and deliberately does not appear in env.ts,
 *  which mirrors wrangler and nothing else. It is SYNTHESISED here from the FINISH_CONTAINER
 *  binding (cf#810) and handed to core in place of a public origin. */
export type StudioEnv = Env & OrchestratorEnv & VideoFinishDoorHost;

/** The ONE place this Worker meters object writes (core#52).
 *
 *  Every write in this deploy reaches the bucket through the env handed to a route handler or to core
 *  orchestration, and both come from studioEnv, so wrapping here is the single seam that cannot be
 *  bypassed by adding a route. A write that goes around this env is by definition unaccounted, which is
 *  why the wrapper lives at the entry point rather than at ~30 call sites.
 *
 *  The wrap is idempotent (core marks a metered store), which matters here specifically: studioEnv runs
 *  on every request against the SAME isolate-level env object, so a non-idempotent wrapper would stack
 *  proxies and double count.
 *
 *  The casts are the load-bearing kind documented in tests/orchestrator-env.ts: the Cloudflare R2Bucket
 *  overloads get() while core narrows it, so the two types are genuinely incompatible even though the
 *  runtime object is the same. The wrapper is a pass-through Proxy, so the binding keeps its full
 *  Workers surface (multipart and friends) and only put/delete are intercepted. */
function meterStudioWrites(raw: Env): void {
  raw.R2_RENDERS = meteredR2Bucket(
    raw.R2_RENDERS as unknown as CoreR2Bucket,
    raw.DB as unknown as CoreDatabase,
  ) as unknown as Env["R2_RENDERS"];
}

export function studioEnv(raw: Env): StudioEnv {
  if (raw.R2_RENDERS && raw.DB) meterStudioWrites(raw);
  const { PRESIGNER } = orchestratorEnv(raw);
  return Object.assign(raw, { PRESIGNER, ...videoFinishDoorField(raw) }) as StudioEnv;
}

/** The video-finish door, when this deploy has the container bound (cf#810).
 *
 *  OPTIONAL BY CONSTRUCTION. A self-host with no FINISH_CONTAINER binding gets no door and falls
 *  through to the VIDEO_FINISH_URL path in core exactly as before, which is what keeps this change
 *  invisible to every deploy that is not ours.
 *
 *  Reused rather than rebuilt, for the same reason meterStudioWrites is idempotent: studioEnv runs
 *  on EVERY request against the same isolate-level env object, so minting a fresh closure per
 *  request would be pure garbage for no behaviour change. */
function videoFinishDoorField(raw: Env): VideoFinishDoorHost {
  const existing = (raw as Env & VideoFinishDoorHost).VIDEO_FINISH_DOOR;
  if (existing) return { VIDEO_FINISH_DOOR: existing };
  if (!raw.FINISH_CONTAINER) return {};
  return { VIDEO_FINISH_DOOR: videoFinishDoor(raw.FINISH_CONTAINER) };
}

/** Test helper: attach a mock presigner without wrapping R2 (keeps mem mocks intact). */
export function attachPresigner<T extends object>(env: T): T & Pick<OrchestratorEnv, "PRESIGNER"> {
  return Object.assign(env, {
    PRESIGNER: {
      presignGet: async (key: string) => `https://presign.test/${key}?sig=test`,
      presignPut: async (key: string) => `https://presign.test/put/${key}?sig=test`,
    },
  });
}
