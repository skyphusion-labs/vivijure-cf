import { orchestratorEnv } from "../src/orchestrator-env.js";
import type { Env } from "../src/env.js";
import type { OrchestratorEnv } from "@skyphusion-labs/vivijure-core/platform";

/** Wrap a test Env with Platform ICD fields (PRESIGNER, wrapped R2). */
export function orch(env: Env): OrchestratorEnv {
  return orchestratorEnv(env);
}
