// The model layer for plan.enhance: pick a provider, call it, extract the reply.
//
// Two providers, in preference order:
//   1. Opus via Cloudflare AI Gateway (Unified Billing, keyless) -- the cinematic-director pass.
//      Two transports reach it (opusTransport):
//        - "token": a fetch to the gateway's Anthropic endpoint with cf-aig-authorization. Used
//          whenever CF_AIG_TOKEN is set, exactly as before.
//        - "binding": env.AI.run(<catalog id>, <Anthropic Messages body>, { gateway }). The AI binding
//          is pre-authenticated, so no token is needed. OPT-IN with ENHANCE_OPUS_BINDING=1, so a
//          deployment that has GATEWAY_ID and no token keeps the free local model it has today
//          instead of starting to spend.
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
/** The gateway options this module passes on env.AI.run (AI Gateway binding reference). */
export interface BindingGatewayOptions {
  id: string;
  skipCache?: boolean;
  metadata?: Record<string, string>;
}

export interface ProviderEnv {
  AI: {
    run(model: string, input: unknown, opts?: { gateway?: BindingGatewayOptions }): Promise<unknown>;
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
  /** "1" opts in to the token-free binding transport for Opus. Plain text, not a secret. */
  ENHANCE_OPUS_BINDING?: string;
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

export type OpusTransport = "token" | "binding";

/** How Opus is reached on this deployment, or null when it is not. The token wins when both are
 *  configured, so a deployment that has a token behaves exactly as before. Pure. */
export function opusTransport(env: ProviderEnv): OpusTransport | null {
  if (!env.GATEWAY_ID) return null;
  if (env.CF_AIG_TOKEN) return "token";
  if (env.ENHANCE_OPUS_BINDING?.trim() === "1") return "binding";
  return null;
}

/** Pick the provider for a call. A Workers AI id ("@cf/...") always routes local regardless of
 *  gateway config; otherwise Opus when a transport is configured (opusTransport). Pure, so the
 *  selection is unit-tested. */
export function pickProvider(env: ProviderEnv, modelId?: string): Provider {
  if (modelId?.trim().startsWith("@cf/")) return "local";
  return opusTransport(env) ? "opus" : "local";
}

/** The AI Gateway CATALOG id for an Anthropic slug, or null when the slug has no known catalog form.
 *
 * The binding looks a model up by its exact catalog name, and the catalog spells Claude versions
 * with a dot where Anthropic uses a dash: "claude-opus-4-8" is "anthropic/claude-opus-4.8", and
 * "anthropic/claude-opus-4-8" does not resolve (Cloudflare model catalog and AI SDK docs). A
 * version with no minor ("claude-fable-5") is the same in both. Anything else returns null rather
 * than a guess, so the caller fails over to the local model instead of sending a name the gateway
 * will not find. Pure. */
export function anthropicCatalogId(slug: string): string | null {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(slug.trim().replace(/^anthropic\//, ""));
  if (!m) return null;
  return `anthropic/claude-${m[1]}-${m[2]}${m[3] !== undefined ? "." + m[3] : ""}`;
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
  const meta = aigMetadataObject(env);
  return meta ? JSON.stringify(meta) : null;
}

/** The same attribution as an object, for the binding's `gateway.metadata` option. Pure. */
export function aigMetadataObject(env: ProviderEnv): Record<string, string> | null {
  const tenantId = safeAttribution(env.TENANT_ID);
  if (!tenantId) return null;
  const meta: Record<string, string> = { tenant_id: tenantId };
  const slug = safeAttribution(env.TENANT_SLUG);
  if (slug) meta.slug = slug;
  return meta;
}

/** Output budget for plan, refine and the director pass, which all scale with the shot count.
 *  Thinking tokens count against it. Every model in the catalog allows 128K synchronously, but this
 *  call does not stream: Anthropic advises against a large max_tokens without streaming, and the
 *  official SDK refuses a non-streaming request above 3600 s * max_tokens / 128000 = 600 s, which
 *  is 21333 tokens. This is the largest round value under that line. */
export const LONG_OUTPUT_MAX_TOKENS = 21000;
/** Output budget for the one-line chat helpers. */
export const CHAT_MAX_TOKENS = 4096;

/** The model stopped and running the same request on another provider would be wrong: the reply was
 *  cut off, or the model refused. direct() does not fall back on this, because a weaker model must
 *  not answer what a refusal declined, and a fallback would bury the true reason. */
export class ModelStoppedError extends Error {}

/** Why a 200 reply is not usable, from its stop_reason, or null when it is. Only enumerated values
 *  and numbers reach the message, never reply text (cf#223). Pure. */
export function stopFailure(raw: unknown, maxTokens: number): string | null {
  const r = raw as {
    stop_reason?: unknown;
    usage?: { output_tokens_details?: { thinking_tokens?: unknown } };
  } | null;
  if (r?.stop_reason === "refusal") return "anthropic refused the request (stop_reason refusal)";
  if (r?.stop_reason !== "max_tokens") return null;
  const thinking = r.usage?.output_tokens_details?.thinking_tokens;
  const spent = typeof thinking === "number" ? `, ${thinking} thinking tokens` : "";
  return `anthropic reply was cut off (stop_reason max_tokens, limit ${maxTokens} output tokens${spent}); ask for fewer shots`;
}

export interface OpusCallOptions {
  /** Defaults to CHAT_MAX_TOKENS. */
  maxTokens?: number;
  /** Do not answer from the AI Gateway cache. */
  skipCache?: boolean;
}

/** Call Opus through the AI Gateway, by whichever transport this deployment has (opusTransport).
 *  Throws on no transport, a failed call, or an empty reply, so the caller can fall back, and throws
 *  ModelStoppedError on a truncated or refused reply, which the caller must not fall back on. */
export async function callOpus(
  env: ProviderEnv,
  messages: ChatMessage[],
  modelOverride?: string,
  opts: OpusCallOptions = {},
): Promise<string> {
  const transport = opusTransport(env);
  const gatewayId = env.GATEWAY_ID;
  if (!transport || !gatewayId) {
    throw new Error("opus requires GATEWAY_ID and CF_AIG_TOKEN, or GATEWAY_ID and ENHANCE_OPUS_BINDING=1");
  }
  if (transport === "binding") return await callOpusBinding(env, messages, modelOverride, opts);
  const baseUrl = await env.AI.gateway(gatewayId).getUrl("anthropic");
  const { system, messages: aMessages } = toAnthropic(messages);
  const maxTokens = opts.maxTokens ?? CHAT_MAX_TOKENS;

  const body: Record<string, unknown> = {
    model: opusModel(env, modelOverride),
    max_tokens: maxTokens,
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
  if (opts.skipCache) headers["cf-aig-skip-cache"] = "true";

  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    // cf#223: this body is NOT ours. An Anthropic 4xx echoes the offending request content, and
    // this module's input is the user's STORYBOARD -- so 300 raw characters of it were reaching a
    // thrown message, and from there both the `error` string this module returns AND
    // `output.notes`, which is persisted and rendered in the planner. Anthropic's own error `type`
    // is drawn from an enumerated set and is safe; the prose is dropped.
    let detail = "";
    try {
      const e = (await resp.json()) as { error?: { type?: string } };
      if (e?.error?.type) detail = ` (${e.error.type})`;
    } catch { /* non-JSON error body; status alone is enough */ }
    throw new Error(`anthropic ${resp.status}${detail}`);
  }
  const raw: unknown = await resp.json();
  const stopped = stopFailure(raw, maxTokens);
  if (stopped) throw new ModelStoppedError(stopped);
  const text = extractAnthropicText(raw);
  if (!text) throw new Error("anthropic returned no text content");
  return text;
}

/** The binding transport: env.AI.run with the catalog id and an Anthropic Messages body. The binding
 *  returns the native Anthropic message JSON (the same shape the token path reads), so stopFailure
 *  and extractAnthropicText apply unchanged. */
async function callOpusBinding(
  env: ProviderEnv,
  messages: ChatMessage[],
  modelOverride: string | undefined,
  opts: OpusCallOptions,
): Promise<string> {
  const slug = opusModel(env, modelOverride);
  const model = anthropicCatalogId(slug);
  if (!model) throw new Error(`opus binding: no catalog id for model ${slug}`);
  const { system, messages: aMessages } = toAnthropic(messages);
  const maxTokens = opts.maxTokens ?? CHAT_MAX_TOKENS;
  const body: Record<string, unknown> = { max_tokens: maxTokens, messages: aMessages };
  if (system) body.system = system;

  const gateway: BindingGatewayOptions = { id: env.GATEWAY_ID as string };
  // Same attribution as the token path's cf-aig-metadata header, omitted on a self-hosted install.
  const metadata = aigMetadataObject(env);
  if (metadata) gateway.metadata = metadata;
  if (opts.skipCache) gateway.skipCache = true;

  let raw: unknown;
  try {
    raw = await env.AI.run(model, body, { gateway });
  } catch (e) {
    // cf#223: a provider error can echo the request, which is the user's storyboard. Only the error
    // class name reaches the message, never its text.
    throw new Error(`anthropic binding call failed (${(e as Error)?.name || "Error"})`);
  }
  const stopped = stopFailure(raw, maxTokens);
  if (stopped) throw new ModelStoppedError(stopped);
  const text = extractAnthropicText(raw);
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
  const res = (await env.AI.run(model, { messages })) as { response?: string | string[] } | null | undefined;
  return res?.response;
}
