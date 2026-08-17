import { afterEach } from "vitest";
import { attachPresigner } from "../src/orchestrator-env.js";
import type { OrchestratorEnv } from "@skyphusion-labs/vivijure-core/platform";
import type { Env } from "../src/env.js";

let undoFetch: (() => void) | undefined;
afterEach(() => {
  undoFetch?.();
  undoFetch = undefined;
});

/**
 * Attach a mock PRESIGNER for orchestration calls in unit tests (cf#107).
 *
 * TWO defects were hiding behind this helper, both invisible because tsconfig never typechecked
 * tests/: vitest transpiles without checking, so the suite ran green while the types disagreed.
 *
 * 1. The return type was declared `: T`, which threw away the PRESIGNER attachPresigner had just
 *    added. Every call site handed a bare Env to something wanting an OrchestratorEnv.
 *
 * 2. Fixing (1) exposed the real one: the studio Env is NOT structurally an OrchestratorEnv. The
 *    Cloudflare R2Bucket.get is overloaded (an onlyIf form and a plain form) while core narrows it
 *    to a single signature, so the two R2 types are genuinely incompatible. Production never hits
 *    this because it goes through cfPlatformFromEnv, which WRAPS R2 (cfObjectStoreFromR2); studioEnv
 *    then casts. These tests deliberately do NOT wrap -- attachPresigner exists precisely to keep the
 *    in-memory R2 mocks intact -- so the mismatch is real and unavoidable here.
 *
 * The cast is therefore load-bearing and stays, but it lives in exactly ONE reviewed place instead of
 * being sprayed across ~40 test files. It asserts: the mem-mock R2 satisfies the subset of R2Bucket
 * these orchestration paths actually call. If an orchestrator starts using an R2 method the mocks do
 * not implement, that surfaces as a runtime failure in the suite, not a silent pass.
 */
type DoorFetch = { fetch?: (u: RequestInfo, i?: RequestInit) => Promise<Response> };

export function orch<T extends Env>(env: T): T & OrchestratorEnv {
  const rec = env as {
    VIDEO_FINISH_URL?: string;
    AUDIO_MIX_URL?: string;
    AUDIO_BEAT_SYNC_URL?: string;
    IMAGE_PREP_URL?: string;
    MEDIA_DOOR_FETCH?: DoorFetch;
  };
  const door = rec.MEDIA_DOOR_FETCH?.fetch ? rec.MEDIA_DOOR_FETCH : undefined;
  if (door?.fetch) {
    if (rec.VIDEO_FINISH_URL === undefined) rec.VIDEO_FINISH_URL = "https://video-finish.test";
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/video-finish|audio-mix|audio-beat-sync|image-prep/.test(u)) {
        return door.fetch!(input as RequestInfo, init);
      }
      return prev.call(globalThis, input as never, init);
    }) as typeof fetch;
    undoFetch = () => {
      globalThis.fetch = prev;
    };
  }
  return attachPresigner(env) as unknown as T & OrchestratorEnv;
}

export { attachPresigner };
