import { secretValue } from "@skyphusion-labs/vivijure-core/secret-store";
import type { SecretStore } from "./types.js";
import type { Env } from "../env.js";

/** Secrets Store bindings + plain string test values. */
export function cfSecretStoreFromEnv(env: Env): SecretStore {
  return {
    async get(name: string) {
      const raw = (env as unknown as Record<string, unknown>)[name];
      if (raw === undefined) return undefined;
      const value = await secretValue(raw as Parameters<typeof secretValue>[0]);
      return value || undefined;
    },
  };
}
