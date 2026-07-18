import { attachPresigner } from "../src/orchestrator-env.js";
import type { OrchestratorEnv } from "@skyphusion-labs/vivijure-core/platform";
import type { Env } from "../src/env.js";

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
export function orch<T extends Env>(env: T): T & OrchestratorEnv {
  return attachPresigner(env) as unknown as T & OrchestratorEnv;
}

export { attachPresigner };
