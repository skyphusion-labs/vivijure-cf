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
  const { PRESIGNER } = orchestratorEnv(raw);
  return Object.assign(raw, { PRESIGNER }) as StudioEnv;
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
