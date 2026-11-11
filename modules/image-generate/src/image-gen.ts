// The image-generation dispatch layer, ported from the studio's src/chat-image.ts (cf#129 phase 2).
//
// This is the LIVE path the studio ran before the port, moved wholesale rather than rewritten: the
// per-model quirks below are all things that were learned from real failures, and a clean-room
// rewrite would have relearned them the same expensive way. Pure functions plus one entry point, so
// the whole thing is unit-testable without a Worker.

// cf#223: three PURE label functions, no Env or binding, so the "unit-testable without a Worker"
// property stated above still holds.
import { untrustedLabel } from "../../_shared/log-scrub";
import { PROVIDER_IMAGE_MAX_BYTES, readProviderMedia } from "../../_shared/provider-media";

export interface AiRun {
  run(model: string, params: unknown, opts?: unknown): Promise<unknown>;
}

export type Provider = "workers-ai" | "google" | "openai" | "recraft" | "bytedance" | "xai";

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked: the naive btoa(String.fromCharCode(...bytes)) spreads every byte as an argument and
  // overflows the call stack on multi-MB images. 0x8000 is the standard safe window.
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

export function isFlux2(model: string): boolean {
  return model.startsWith("@cf/black-forest-labs/flux-2");
}

/** Sniff the real mime from magic bytes. FLUX-2 klein returns JPEG despite the PNG-ish API shape,
 *  so a hardcoded mime would store bytes whose type is a lie. */
export function sniffImageMime(bytes: ArrayBuffer | Uint8Array): { mime: string; ext: string } {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return { mime: "image/webp", ext: "webp" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { mime: "image/gif", ext: "gif" };
  return { mime: "image/png", ext: "png" };
}

/** Recraft models that refuse a `style`. The gateway log for a 7003 on recraft/recraftv4 carried the
 *  provider's own error: "Recraft V4 doesn't support style 'digital_illustration'" (code
 *  invalid_image_type), vivijure-cf#1141. Cloudflare's schema-input.json lists `style` as a free string,
 *  so the schema cannot tell you this; only the provider can. */
export function recraftRefusesStyle(model: string): boolean {
  return model.startsWith("recraft/recraftv4");
}

/** Params for a proxied (non-@cf) image model, with or without reference images. Keyed on the MODEL,
 *  not the provider, because two models of one provider can take different bodies (Recraft V4). */
export function proxiedParams(model: string, prompt: string, imageInputs: string[] = []): Record<string, unknown> {
  // schema-input.json 2026-10-30: prompt required, image_input maxItems 14, additionalProperties false.
  if (model === "bytedance/seedream-5-lite") {
    const p: Record<string, unknown> = { prompt };
    if (imageInputs.length) p.image_input = imageInputs.slice(0, 14);
    return p;
  }
  if (model.startsWith("google/")) {
    const p: Record<string, unknown> = { prompt, output_format: "png" };
    if (imageInputs.length) p.image_input = imageInputs.slice(0, 8);
    return p;
  }
  if (model.startsWith("openai/")) {
    const p: Record<string, unknown> = { prompt, quality: "high", size: "1024x1024" };
    if (imageInputs.length) p.images = imageInputs.slice(0, 16);
    return p;
  }
  if (model.startsWith("recraft/")) {
    return recraftRefusesStyle(model)
      ? { prompt, size: "1024x1024" }
      : { prompt, size: "1024x1024", style: "digital_illustration" };
  }
  // xAI: the default URL output is refused for a zero-data-retention team, and every Cloudflare
  // proxied call is one. Provider error from the gateway log (vivijure-cf#1141): "Zero Data Retention
  // teams do not have access to URL format as it requires storing the generated images. Please use
  // response_format="b64_json" instead." schema-input.json for xai/grok-imagine-image lists
  // response_format enum [url, b64_json]. Reference images are not sent on this path yet.
  if (model.startsWith("xai/")) return { prompt, response_format: "b64_json" };
  return { prompt };
}

/** The image REFERENCE a proxied result carries: an https URL, a data: URL, or raw base64 (xAI with
 *  response_format b64_json). proxiedImageBytes turns any of the three into bytes. */
export function extractProxiedImageUrl(result: unknown): string | null {
  const outer = result as Record<string, unknown> | null;
  if (!outer || typeof outer !== "object") return null;
  // AI.run can wrap the provider's output in `{ state, result }`. cloud-keyframe and cast-image have
  // always read this shape, and this module did not (vivijure-cf#1141).
  const inner = outer.result;
  const r = (inner && typeof inner === "object" && !Array.isArray(inner) ? inner : outer) as Record<string, unknown>;
  // schema-output.json 2026-10-31: google, xai, recraft and openai publish `image`; seedream `images`.
  if (typeof r.image === "string" && r.image.length > 0) return r.image;
  const direct = r.url ?? r.image_url ?? r.output_url;
  if (typeof direct === "string") return direct;
  const arr = (r.data ?? r.images ?? r.output) as unknown;
  if (Array.isArray(arr) && arr.length) {
    const first = arr[0] as Record<string, unknown> | string;
    if (typeof first === "string") return first;
    const u = first?.url ?? first?.image_url ?? first?.b64_json;
    if (typeof u === "string" && u.length > 0) return u;
  }
  return null;
}

const RAW_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** JPEG, PNG, WebP (RIFF) or GIF magic bytes. */
export function hasImageMagic(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return true;
  return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
}

/** Bytes for a proxied image reference. A URL is fetched; a data: URL or raw base64 is decoded here,
 *  because fetch() on a base64 string is not a request (vivijure-cf#1141, xAI b64_json). Anything
 *  else throws, so the caller fails loud rather than storing a non-picture. */
export async function proxiedImageBytes(ref: string): Promise<{ bytes: Uint8Array; mime: string }> {
  if (/^https?:\/\//i.test(ref)) {
    const resp = await fetch(ref);
    if (!resp.ok) throw new Error(`failed to fetch generated image: ${resp.status}`);
    // Sniff wins over the header. A type outside the allowlist is not stored.
    const media = await readProviderMedia(resp, { maxBytes: PROVIDER_IMAGE_MAX_BYTES, fallbackType: "image/png" });
    return { bytes: media.bytes, mime: media.contentType };
  }
  const parsed = parseDataUrl(ref);
  const b64 = (parsed ? parsed.base64 : ref).replace(/\s+/g, "");
  if (!b64 || !RAW_BASE64.test(b64)) {
    throw new Error("image generation returned an image that is neither a URL nor base64");
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    throw new Error("image generation returned undecodable base64");
  }
  // Base64 text is not proof of a picture: any run of letters is valid base64. Require image magic
  // bytes, then sniff the mime rather than trust a declared type, as the @cf paths do.
  if (!hasImageMagic(bytes)) throw new Error("image generation returned base64 that is not an image");
  return { bytes, mime: sniffImageMime(bytes).mime };
}

/** Anything the proxied providers return that means "we refused", so a flagged generation fails
 *  loudly instead of storing an empty object as if it were a picture. */
export function detectProviderFailure(result: unknown): string | null {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const err = r.error ?? r.message;
  if (typeof err === "string" && err.trim()) return err;
  return null;
}

/** Providers whose catalog id carries a routing prefix; everything else is a plain @cf model. */
export function providerOf(modelId: string): Provider | undefined {
  if (modelId.startsWith("google/")) return "google";
  if (modelId.startsWith("openai/")) return "openai";
  if (modelId.startsWith("recraft/")) return "recraft";
  if (modelId.startsWith("bytedance/")) return "bytedance";
  if (modelId.startsWith("xai/")) return "xai";
  return undefined;
}

/** OpenAI direct (BYOK): the only path to a real alpha channel.
 *
 *  The Unified Billing proxy for gpt-image-1.5 exposes a strict schema and 7003-rejects `background`
 *  and `output_format`, so a transparent PNG is impossible through it. OpenAI's own endpoint accepts
 *  both. GPT image models always return b64_json (the `url` response format is unsupported), so
 *  there is nothing to fetch. */
export async function generateOpenAIImage(
  apiKey: string,
  modelId: string,
  prompt: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const model = modelId.replace(/^openai\//, "");
  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, prompt, size: "1024x1024", quality: "high",
      background: "transparent", output_format: "png",
    }),
  });
  if (!resp.ok) {
    // cf#223: the provider MESSAGE is not ours and is not content-free. A moderation refusal from
    // this API quotes the prompt back ("Your request was rejected... your prompt may contain..."),
    // so interpolating it verbatim put a USER PROMPT into an exception message -- which reaches the
    // caller, the `error` string this module returns, any log sink, and the Exceptions channel.
    // The machine-readable `code`/`type` say what happened and are drawn from the provider's own
    // ENUMERATED set, so they cannot carry content; the prose is dropped.
    let detail = "";
    try {
      const e = (await resp.json()) as { error?: { code?: string; type?: string } };
      const reason = e?.error?.code ?? e?.error?.type;
      detail = reason ? ` (${reason})` : "";
    } catch { /* non-JSON error body; status alone is enough */ }
    throw new Error(`OpenAI image API ${resp.status}${detail}`);
  }
  const data = (await resp.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image API returned no b64_json image data");
  return { bytes: base64ToBytes(b64), mime: "image/png" };
}

export interface GenerateEnv {
  AI: AiRun;
  GATEWAY_ID?: string;
  OPENAI_API_KEY?: string;
}

export interface GenerateArgs {
  model: string;
  prompt: string;
  negative_prompt?: string;
  refs?: string[];
  width?: number;
  height?: number;
}

/** Generate ONE image and return its raw bytes + real mime. Throws on any refusal or empty result,
 *  so the caller reports an honest error rather than storing a non-picture. */
export async function generateImageBytes(
  env: GenerateEnv,
  args: GenerateArgs,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const model = args.model;
  const provider = providerOf(model);
  const width = args.width ?? 1024;
  const height = args.height ?? 1024;

  if (provider) {
    // BYOK direct for OpenAI when a key is present: the only transparent-PNG path.
    // Transparent PNG is the legacy 1.5 BYOK path. gpt-image-2 schema lists `background`,
    // and the models index says transparent is not supported on that id. Do not send it
    // until a render proves which of those is true. A key does not divert gpt-image-2.
    if (provider === "openai" && model === "openai/gpt-image-1.5" && env.OPENAI_API_KEY) {
      return await generateOpenAIImage(env.OPENAI_API_KEY, model, args.prompt);
    }
    const refs = (args.refs ?? []).filter((r) => r.startsWith("data:"));
    const params = proxiedParams(model, args.prompt, refs);
    const opts = env.GATEWAY_ID ? { gateway: { id: env.GATEWAY_ID } } : undefined;
    const result = await env.AI.run(model, params, opts);
    const failure = detectProviderFailure(result);
    // cf#223: `failure` is free provider text lifted out of the AI.run result, and a moderation
    // refusal quotes the prompt. There is no enumerated code on this path, so the label carries a
    // stable id and the length instead -- enough to correlate two reports of the same refusal and
    // to see that a body was present, with none of its content.
    if (failure) throw new Error(`image generation failed (provider message ${untrustedLabel(failure)})`);
    const ref = extractProxiedImageUrl(result);
    if (!ref) throw new Error("image generation returned no image URL");
    return await proxiedImageBytes(ref);
  }

  // ---- plain @cf models ----
  if (isFlux2(model)) {
    // FLUX-2 needs multipart and is gateway-incompatible, so it runs the binding directly.
    // FormData does not expose its serialized body/boundary; wrapping in a Response yields both.
    const form = new FormData();
    form.append("prompt", args.prompt);
    form.append("width", String(width));
    form.append("height", String(height));
    if (args.negative_prompt?.trim()) form.append("negative_prompt", args.negative_prompt);
    let i = 0;
    for (const ref of args.refs ?? []) {
      if (i >= 4) break;
      const parsed = parseDataUrl(ref);
      if (!parsed) continue;
      form.append(`input_image_${i}`, new Blob([base64ToBytes(parsed.base64)], { type: parsed.mime }), `ref-${i}.png`);
      i++;
    }
    const fr = new Response(form);
    const result = await env.AI.run(model, {
      multipart: { body: fr.body, contentType: fr.headers.get("content-type") },
    });
    const b64 = (result as { image?: string })?.image;
    if (!b64 || typeof b64 !== "string") throw new Error("flux-2 returned no image");
    const bytes = base64ToBytes(b64);
    return { bytes, mime: sniffImageMime(bytes).mime };
  }

  const params: Record<string, unknown> = { prompt: args.prompt, width, height, steps: 25 };
  if (args.negative_prompt?.trim()) params.negative_prompt = args.negative_prompt;
  if (model === "@cf/black-forest-labs/flux-1-schnell") {
    // schnell is a 4-step distilled model and rejects a negative prompt.
    params.steps = 4;
    delete params.negative_prompt;
  }
  const isSdxl = model === "@cf/stabilityai/stable-diffusion-xl-base-1.0";
  if (isSdxl) {
    // SDXL names its step count differently; sending `steps` is silently ignored.
    delete params.steps;
    params.num_steps = 20;
  }
  // These models are gateway-incompatible through the binding, so they run direct.
  const bypassGateway = model === "@cf/leonardo/phoenix-1.0"
    || model === "@cf/leonardo/lucid-origin"
    || model === "@cf/lykon/dreamshaper-8-lcm"
    || isSdxl;
  const opts = !bypassGateway && env.GATEWAY_ID ? { gateway: { id: env.GATEWAY_ID } } : undefined;
  const result = await env.AI.run(model, params, opts);

  if (result instanceof ReadableStream) {
    const reader = result.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { chunks.push(value); total += value.length; }
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
    return { bytes, mime: sniffImageMime(bytes).mime };
  }

  const b64 = (result as { image?: string })?.image;
  if (!b64 || typeof b64 !== "string") throw new Error("image generation returned no image");
  const bytes = base64ToBytes(b64);
  return { bytes, mime: sniffImageMime(bytes).mime };
}
