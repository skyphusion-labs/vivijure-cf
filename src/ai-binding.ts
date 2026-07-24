// env.AI binding wrappers (v0.19.3).
//
// Extracted from src/index.ts so provider modules and other code paths that
// call env.AI.run (chat, STT, image gen, TTS, embeddings, the LongRun
// workflow) share one binding wrapper rather than each constructing its
// own opts object.
//
// `aiRun` is the standard call path: pass model, params, optional flag to
// return the raw Response (rather than a parsed object) for binary-output
// models like TTS.
//
// `aiLogId` reads the Cloudflare AI Gateway log ID from the env.AI binding
// after a call, when one exists. The binding mutates a per-invocation field
// after each .run(); calling aiLogId immediately after aiRun returns the
// log ID for that specific call.

import type { Env } from "./env";
import { secretValue } from "@skyphusion-labs/vivijure-core/secret-store";

type RunOpts = { gateway: { id: string }; returnRawResponse?: boolean };
type RunFn = (model: string, params: unknown, opts?: RunOpts) => Promise<unknown>;

export async function aiRun(env: Env, model: string, params: unknown, returnRaw = false): Promise<unknown> {
  const opts: RunOpts = { gateway: { id: await secretValue(env.GATEWAY_ID) } };
  if (returnRaw) opts.returnRawResponse = true;
  return (env.AI as unknown as { run: RunFn }).run(model, params, opts);
}

export function aiLogId(env: Env): string | null {
  return (env.AI as unknown as { aiGatewayLogId?: string }).aiGatewayLogId ?? null;
}

/**
 * Can this deploy actually SERVE an AI-Gateway-backed hook right now? (cf#98)
 *
 * The planner, chat and enhance routes all need `env.AI` bound AND a resolvable `GATEWAY_ID`. A
 * deploy missing either has the plan.enhance MODULE installed and cannot run it -- which is the
 * whole defect: `/api/storyboard/models` used to project purely from installed modules, so a hosted
 * tenant provisioned without these bindings got a full model picker whose every option 500s.
 *
 * It RESOLVES the secret rather than checking that the binding merely exists. A bound-but-empty
 * gateway id fails at call time exactly like an absent one, and reporting a capability we have not
 * actually confirmed is the thing this function exists to stop doing. A throw is unavailable, not an
 * error to propagate: the caller's question is "can we serve it", and "we could not even find out"
 * has the same answer.
 */
export async function aiGatewayReady(env: Env): Promise<boolean> {
  if (!(env as unknown as { AI?: unknown }).AI) return false;
  try {
    const id = await secretValue(env.GATEWAY_ID);
    return typeof id === "string" && id.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Shown to a TENANT who very likely cannot fix it themselves, so it names what to DO rather than
 * only what is wrong, and avoids operator jargon as the headline. The binding names stay, at the
 * end and in parentheses, so an operator reading the same string knows exactly which knob to turn.
 * Printed VERBATIM by the panel (it is projected, never re-worded), so this text is the product.
 */
export const PLANNER_UNAVAILABLE_REASON =
  "Storyboard planning is unavailable on this studio because its AI Gateway is not configured. " +
  "Ask whoever operates this studio to enable it (the AI binding and GATEWAY_ID).";
