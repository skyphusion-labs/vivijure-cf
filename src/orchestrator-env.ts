import {
  orchestratorContextFromPlatform,
  type OrchestratorEnv,
} from "@skyphusion-labs/vivijure-core/platform";
import { cfPlatformFromEnv } from "./platform/cf-platform.js";
import type { Env } from "./env.js";

/** Platform ICD env for orchestration (PRESIGNER + wrapped R2). */
export function orchestratorEnv(env: Env): OrchestratorEnv {
  return orchestratorContextFromPlatform(cfPlatformFromEnv(env));
}

/** Workers Env merged with orchestration fields for route handlers. */
export type StudioEnv = Env & OrchestratorEnv;

export function studioEnv(raw: Env): StudioEnv {
  return Object.assign(raw, orchestratorEnv(raw)) as StudioEnv;
}
