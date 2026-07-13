import type { Platform } from "./types.js";
import { platformAsEnv } from "./types.js";

/** Env bag for `discoverModules()` (service bindings + dispatch namespace). */
export function moduleEnvFromPlatform(platform: Platform): Record<string, unknown> {
  const bag = platformAsEnv(platform);
  if (platform.vars.AUTH_MODE) bag.AUTH_MODE = platform.vars.AUTH_MODE;
  const dispatch = (platform.vars as Record<string, unknown>).MODULE_DISPATCH;
  if (dispatch) bag.MODULE_DISPATCH = dispatch;
  return bag;
}

export { cfPlatformFromEnv } from "./cf-platform.js";
export { cfPresignerFromEnv } from "./cf-presigner.js";
export { cfSecretStoreFromEnv } from "./cf-secrets.js";
export { cfModuleTransportFromEnv } from "./cf-module-transport.js";
