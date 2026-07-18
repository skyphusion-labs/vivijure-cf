// The image-generation dispatch layer, ported from the studio's src/chat-image.ts (cf#129 phase 2).
//
// This is the LIVE path the studio ran before the port, moved wholesale rather than rewritten: the
// per-model quirks below are all things that were learned from real failures, and a clean-room
// rewrite would have relearned them the same expensive way. Pure functions plus one entry point, so
// the whole thing is unit-testable without a Worker.

export interface AiRun {
  run(model: string, params: unknown, opts?: unknown): Promise<unknown>;
}

export type Provider = "workers-ai" | "google" | "openai" | "recraft";

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
  return { mime: "image/png", ext: "png" };
}

/** Per-provider params for proxied (non-@cf) text-to-image models. */
export function buildProxiedImageParams(provider: Provider | undefined, prompt: string): Record<string, unknown> {
  switch (provider) {
    case "google":
      return { prompt, output_format: "png" };
    case "openai":
      return { prompt, quality: "high", size: "1024x1024" };
    case "recraft":
      return { prompt, size: "1024x1024", style: "digital_illustration" };
    default:
      return { prompt };
  }
}

/** Proxied params WITH reference images (multi-reference models). */
export function proxiedParams(model: string, prompt: string, imageInputs: string[] = []): Record<string, unknown> {
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
  if (model.startsWith("recraft/")) return { prompt, size: "1024x1024", style: "digital_illustration" };
  return { prompt };
}

export function extractProxiedImageUrl(result: unknown): string | null {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const direct = r.url ?? r.image_url ?? r.output_url;
  if (typeof direct === "string") return direct;
  const arr = (r.data ?? r.images ?? r.output) as unknown;
  if (Array.isArray(arr) && arr.length) {
    const first = arr[0] as Record<string, unknown> | string;
    if (typeof first === "string") return first;
    const u = first?.url ?? first?.image_url;
    if (typeof u === "string") return u;
  }
  return null;
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
    let detail = "";
    try {
      const e = (await resp.json()) as { error?: { message?: string } };
      detail = e?.error?.message ? `: ${e.error.message}` : "";
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
    if (provider === "openai" && env.OPENAI_API_KEY) {
      return await generateOpenAIImage(env.OPENAI_API_KEY, model, args.prompt);
    }
    const refs = (args.refs ?? []).filter((r) => r.startsWith("data:"));
    const params = refs.length
      ? proxiedParams(model, args.prompt, refs)
      : buildProxiedImageParams(provider, args.prompt);
    const opts = env.GATEWAY_ID ? { gateway: { id: env.GATEWAY_ID } } : undefined;
    const result = await env.AI.run(model, params, opts);
    const failure = detectProviderFailure(result);
    if (failure) throw new Error(`image generation failed: ${failure}`);
    const url = extractProxiedImageUrl(result);
    if (!url) throw new Error("image generation returned no image URL");
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`failed to fetch generated image: ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return { bytes, mime: resp.headers.get("content-type") || "image/png" };
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
