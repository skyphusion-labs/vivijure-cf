import { attachPresigner } from "../src/orchestrator-env.js";
import type { Env } from "../src/env.js";

/** Attach mock PRESIGNER for orchestration calls in unit tests. */
export function orch<T extends Env>(env: T): T {
  return attachPresigner(env);
}

export { attachPresigner };
