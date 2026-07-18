import { ORCHESTRATOR_VAR_KEYS } from "./orchestrator-vars.js";
import type { Platform, RateLimiter } from "./types.js";
import type { Env } from "../env.js";
import { cfPresignerFromEnv } from "./cf-presigner.js";
import { cfSecretStoreFromEnv } from "./cf-secrets.js";
import { cfModuleTransportFromEnv } from "./cf-module-transport.js";
import { cfObjectStoreFromR2 } from "./cf-r2-store.js";

// The env contract now lives in a LEAF module (orchestrator-vars.ts) so the release builder can
// stamp it into the manifest without importing the entire Worker runtime graph (cf#85).
// Re-exported here so every existing consumer keeps working unchanged; this is still the
// single source of truth, just relocated one file down.
export { ORCHESTRATOR_VAR_KEYS } from "./orchestrator-vars.js";

function pickOrchestratorVars(env: Env): Record<string, string | undefined> {
  const vars: Record<string, string | undefined> = {};
  for (const key of ORCHESTRATOR_VAR_KEYS) {
    const v = env[key];
    if (typeof v === "string") vars[key] = v;
  }
  return vars;
}

function pickHostBindings(env: Env): Platform["hostBindings"] {
  const out: NonNullable<Platform["hostBindings"]> = {};
  if (env.VIDEO_FINISH_VPC) out.VIDEO_FINISH_VPC = env.VIDEO_FINISH_VPC;
  if (env.IMAGE_PREP_VPC) out.IMAGE_PREP_VPC = env.IMAGE_PREP_VPC;
  if (env.AUDIO_BEAT_SYNC_VPC) out.AUDIO_BEAT_SYNC_VPC = env.AUDIO_BEAT_SYNC_VPC;
  if (env.AUDIO_MIX_VPC) out.AUDIO_MIX_VPC = env.AUDIO_MIX_VPC;
  return out;
}

function cfRateLimiterFromEnv(env: Env): RateLimiter | undefined {
  const binding = env.SPEND_RATE_LIMITER;
  if (!binding) return undefined;
  return {
    limit(key) {
      return binding.limit({ key });
    },
  };
}

/** Build the Platform ICD from a Workers Env (D1 + R2 bindings stay native). */
export function cfPlatformFromEnv(env: Env): Platform {
  const modules = cfModuleTransportFromEnv(env);
  const platform: Platform = {
    db: env.DB,
    renders: cfObjectStoreFromR2(env.R2_RENDERS),
    chatBucket: cfObjectStoreFromR2(env.R2),
    presigner: cfPresignerFromEnv(env),
    secrets: cfSecretStoreFromEnv(env),
    modules,
    rateLimiter: cfRateLimiterFromEnv(env),
    vars: pickOrchestratorVars(env),
    hostBindings: pickHostBindings(env),
  };
  // Registry + discoverModules still read MODULE_DISPATCH from the env bag.
  if (env.MODULE_DISPATCH) {
    (platform.vars as Record<string, unknown>).MODULE_DISPATCH = env.MODULE_DISPATCH;
  }
  return platform;
}
