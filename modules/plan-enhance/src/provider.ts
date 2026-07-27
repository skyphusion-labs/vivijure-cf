// The model layer for plan.enhance: pick a provider, call it, extract the reply.
//
// Two providers, in preference order:
//   1. Opus via Cloudflare AI Gateway (Unified Billing, keyless) -- the cinematic-director pass.
//   2. Workers AI local open-weight model -- the free fallback when no Opus token is configured, or
//      when the Opus call fails. This is the Vivijure modularity thesis in one module: swap an
//      expensive cloud model for a free/local one without changing the hook contract.
//
// The pure pieces (pickProvider, toAnthropic, extractAnthropicText) unit-test without the runtime;
// the I/O (callOpus, callLocal) is a thin shell over them.

import type { ChatMessage } from "./enhance";

// The free fallback model on the account (the module's original, self-contained provider).
export const LOCAL_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// The default cloud model: latest Opus, listed in the core model registry + planner catalog.
export const DEFAULT_OPUS_MODEL = "claude-opus-4-8";

// Structural binding: the Workers AI runner plus the AI Gateway accessor. Kept minimal so the module
// stays free of the full Ai overload surface and any @cloudflare/workers-types version pin.
export interface ProviderEnv {
  AI: {
    run(model: string, input: { messages: ChatMessage[] }): Promise<{ response?: string | string[] }>;
    gateway(id: string): { getUrl(provider: string): Promise<string> };
  };
  GATEWAY_ID?: string;
  CF_AIG_TOKEN?: string;
  /**
   * Hosted-tier attribution (cp#185). Bound as plain_text by the control plane onto the tenant copy
   * of this module; ABSENT on a self-hosted install, which is why both are optional and why the
   * metadata header is omitted entirely rather than emitted empty. Neither is a secret: a tenant id
   * is an opaque identifier and the slug is already public in the tenant own URL.
   */
  TENANT_ID?: string;
  TENANT_SLUG?: string;
  ENHANCE_MODEL?: string;
  // Dev-only mock gate (#411). Unset in prod. See mock.ts.
  PLANNER_AI_MOCK?: string;
}

export type Provider = "opus" | "local";

/** True for a catalog id this module serves through the Anthropic gateway path. Accepts both the
 *  catalog form ("anthropic/claude-opus-4-8") and a bare gateway slug ("claude-opus-4-8"). Pure. */
function isAnthropicModelId(id: string): boolean {
  const s = id.trim();
  return s.startsWith("anthropic/") || s.startsWith("claude-");
}

/** Pick the provider for a call. A Workers AI id ("@cf/...") always routes local regardless of
 *  gateway config; otherwise Opus only when BOTH the gateway id and the Unified-Billing token are
 *  configured. Pure, so the selection is unit-tested. */
export function pickProvider(env: ProviderEnv, modelId?: string): Provider {
  if (modelId?.trim().startsWith("@cf/")) return "local";
  return env.GATEWAY_ID && env.CF_AIG_TOKEN ? "opus" : "local";
}

/** The Anthropic model slug for a call, in precedence order: an explicit per-call override from the
 *  catalog (config.model), else the ENHANCE_MODEL deployment default, else the latest-Opus default.
 *  The "anthropic/" catalog prefix is stripped -- the gateway wants the bare slug. A non-Anthropic
 *  override is ignored here on purpose: pickProvider routes those to the local path instead. Pure. */
export function opusModel(env: ProviderEnv, override?: string): string {
  const fromConfig = override?.trim();
  if (fromConfig && isAnthropicModelId(fromConfig)) {
    return fromConfig.replace(/^anthropic\//, "");
  }
  const m = env.ENHANCE_MODEL?.trim();
  return m && m.length > 0 ? m.replace(/^anthropic\//, "") : DEFAULT_OPUS_MODEL;
}

/** Transform our OpenAI-style chat messages into the Anthropic Messages shape: the system prompt is
 *  pulled to a top-level field, the rest become user/assistant turns. Pure. */
export function toAnthropic(
  messages: ChatMessage[],
): { system?: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  let system: string | undefined;
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
      continue;
    }
    // Our buildMessages only emits system + user; treat anything non-system as a user turn.
    out.push({ role: "user", content: m.content });
  }
  return system ? { system, messages: out } : { messages: out };
}

/** Concatenate the text blocks of an Anthropic Messages response into one string, or null when the
 *  shape has no usable text. Pure. */
export function extractAnthropicText(raw: unknown): string | null {
  const content = (raw as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b): b is { type?: string; text?: string } => typeof b === "object" && b !== null)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  return text.trim().length > 0 ? text : null;
}

/** Characters allowed verbatim in an attribution value.
 *
 * The slug is TENANT-CHOSEN, so it is untrusted input on its way into an HTTP header. A raw CR/LF
 * would be header injection and a non-ASCII byte is not legal in a header value at all, so this is
 * a guard, not cosmetics. Anything outside the set is DROPPED rather than escaped: an attribution
 * key is only useful if it round-trips exactly, and a silently mangled key that still looks valid
 * is worse than an absent one. */
const ATTRIBUTION_UNSAFE = /[^A-Za-z0-9._:-]/g;
const ATTRIBUTION_MAX = 128;

/** Sanitize one attribution value, or undefined when nothing usable survives. Pure. */
function safeAttribution(v: string | undefined): string | undefined {
  const trimmed = v?.trim();
  if (!trimmed) return undefined;
  const cleaned = trimmed.replace(ATTRIBUTION_UNSAFE, "").slice(0, ATTRIBUTION_MAX);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** The `cf-aig-metadata` header value for a call, or null when this install has no tenant identity.
 *
 * THE attribution mechanism for the hosted per-tenant Opus meter (cp#185). The AI Gateway records
 * `authentication` as a BOOLEAN -- it logs THAT a request was authenticated, never WHICH token --
 * so the per-tenant token is the access and revocation boundary and carries no attribution at all.
 * This header is what makes spend attributable: the gateway copies it into the log verbatim, next
 * to a natively-computed `cost`. Two different jobs, deliberately not conflated.
 *
 * Keyed on TENANT_ID and never on the slug alone, because a slug is renameable and therefore
 * worthless as a ledger key; the slug rides along only as a human label. Returns null on a
 * self-hosted install, so no header is sent and parity holds -- a self-hoster billing their own
 * account has nothing to attribute. Pure, so the shape is unit-tested without the runtime. */
export function aigMetadata(env: ProviderEnv): string | null {
  const tenantId = safeAttribution(env.TENANT_ID);
  if (!tenantId) return null;
  const meta: Record<string, string> = { tenant_id: tenantId };
  const slug = safeAttribution(env.TENANT_SLUG);
  if (slug) meta.slug = slug;
  return JSON.stringify(meta);
}

/** Call Opus through the AI Gateway (Unified Billing: cf-aig-authorization only, never x-api-key).
 *  Throws on a missing token, a non-2xx, or an empty reply, so the caller can fall back. */
export async function callOpus(
  env: ProviderEnv,
  messages: ChatMessage[],
  modelOverride?: string,
): Promise<string> {
  if (!env.GATEWAY_ID || !env.CF_AIG_TOKEN) {
    throw new Error("opus requires GATEWAY_ID and CF_AIG_TOKEN");
  }
  const baseUrl = await env.AI.gateway(env.GATEWAY_ID).getUrl("anthropic");
  const { system, messages: aMessages } = toAnthropic(messages);

  const body: Record<string, unknown> = {
    model: opusModel(env, modelOverride),
    max_tokens: 4096,
    messages: aMessages,
  };
  if (system) body.system = system;

  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    // Unified Billing: keyless. An x-api-key would flip the gateway to BYOK billing, so never set one.
    "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
  };
  // Hosted per-tenant attribution (cp#185). Omitted entirely on a self-hosted install rather than
  // sent empty, so a self-hoster emits exactly the request they emitted before this existed.
  const metadata = aigMetadata(env);
  if (metadata) headers["cf-aig-metadata"] = metadata;

  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`anthropic ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const text = extractAnthropicText(await resp.json());
  if (!text) throw new Error("anthropic returned no text content");
  return text;
}

/** Call the free Workers AI local model. Returns its raw reply (string or string array) for the
 *  shared parser; throws on a runner error so the caller can degrade to passthrough. */
export async function callLocal(
  env: ProviderEnv,
  messages: ChatMessage[],
  modelId?: string,
): Promise<string | string[] | undefined> {
  const model = modelId?.trim() || LOCAL_MODEL;
  const res = await env.AI.run(model, { messages });
  return res?.response;
}
