import { DISPATCH_BINDING } from "@skyphusion-labs/vivijure-core/modules/registry";
import type { FetcherLike, ModuleTransport } from "./types.js";
import type { Env } from "../env.js";

function isFetcher(v: unknown): v is FetcherLike {
  return !!v && typeof (v as { fetch?: unknown }).fetch === "function";
}

/** Service bindings (`MODULE_*`) + optional WfP dispatch namespace on env. */
export class CfModuleTransport implements ModuleTransport {
  constructor(private readonly env: Env) {}

  resolve(binding: string): FetcherLike | null {
    if (binding === DISPATCH_BINDING) return null;
    const v = (this.env as unknown as Record<string, unknown>)[binding];
    return isFetcher(v) ? v : null;
  }

  listBindings(): string[] {
    const keys: string[] = [];
    for (const key of Object.keys(this.env)) {
      if (!key.startsWith("MODULE_") || key === DISPATCH_BINDING) continue;
      if (isFetcher((this.env as unknown as Record<string, unknown>)[key])) keys.push(key);
    }
    keys.sort();
    return keys;
  }

  /** WfP dispatch namespace when bound (registry resolves `dispatch:` refs). */
  dispatchNamespace(): Env["MODULE_DISPATCH"] {
    return this.env.MODULE_DISPATCH;
  }
}

export function cfModuleTransportFromEnv(env: Env): CfModuleTransport {
  return new CfModuleTransport(env);
}
