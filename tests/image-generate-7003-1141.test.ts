// vivijure-cf#1141: xai/grok-imagine-image and recraft/recraftv4 answered every chat image call with
// 7003 "User Input Error". The bodies were valid against the published schemas, so the schema could
// not explain it. The AI Gateway log held the provider's own errors:
//
//   xAI:     "Zero Data Retention teams do not have access to URL format as it requires storing the
//            generated images. Please use response_format=\"b64_json\" instead."
//   Recraft: "Recraft V4 doesn't support style 'digital_illustration'" (code invalid_image_type)
//
// Sources for the shapes used here:
//   - modules/image-generate/schemas/*.json are the published documents, fetched 2026-11-06 from
//     https://developers.cloudflare.com/ai/models/<id>/schema-input.json and schema-output.json.
//   - The wrapped result { state, result: { image } } is the example response on each Cloudflare
//     model page (https://developers.cloudflare.com/ai/models/xai/grok-imagine-image/).
//   - xAI base64 output is raw base64, per https://docs.x.ai/developers/model-capabilities/images/generation
//     ("Base64 Output": base64.b64decode(response.data[0].b64_json)).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../modules/image-generate/src/index";
import { proxiedImageBytes, proxiedParams } from "../modules/image-generate/src/image-gen";
import { checkHookOutput } from "@skyphusion-labs/vivijure-core/modules/conformance";

const SCHEMA_DIR = join(import.meta.dirname, "..", "modules/image-generate/schemas");
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PROMPT = "A plain white coffee mug on a grey table, studio photo";

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
};

function loadSchema(file: string): Schema {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as Schema;
}

/** The subset of JSON Schema these two documents use for scalar fields: required, closed
 *  properties, type and enum. Returns every violation so a failure names the field. */
function violations(schema: Schema, body: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of schema.required ?? []) if (!(k in body)) out.push(`missing ${k}`);
  for (const [k, v] of Object.entries(body)) {
    const prop = schema.properties?.[k];
    if (!prop) {
      if (schema.additionalProperties === false) out.push(`unknown ${k}`);
      continue;
    }
    if (prop.type === "string" && typeof v !== "string") out.push(`${k} not a string`);
    if (prop.enum && !prop.enum.includes(v)) out.push(`${k}=${String(v)} not in enum`);
  }
  return out;
}

function invoke(model: string, run: (m: string, p: unknown, o?: unknown) => Promise<unknown>) {
  return worker.fetch(
    new Request("https://module.example/invoke", {
      method: "POST",
      body: JSON.stringify({ hook: "image.generate", input: { prompt: PROMPT, refs: [] }, config: { model } }),
    }),
    { AI: { run }, GATEWAY_ID: "vivijure" } as never,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("xai/grok-imagine-image asks for base64 (cf#1141)", () => {
  const schema = loadSchema("grok-imagine-image.schema-input.json");

  it("sends response_format b64_json, and the published schema accepts it", () => {
    const body = proxiedParams("xai/grok-imagine-image", PROMPT);
    expect(body).toEqual({ prompt: PROMPT, response_format: "b64_json" });
    expect(violations(schema, body)).toEqual([]);
  });

  it("control: the checker refuses a value outside the enum", () => {
    expect(violations(schema, { prompt: PROMPT, response_format: "png" })).toEqual([
      "response_format=png not in enum",
    ]);
  });

  it("decodes the wrapped base64 result without a fetch, and the output is conformant", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("a base64 result must not be fetched");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const sent: unknown[] = [];
    const res = await invoke("xai/grok-imagine-image", async (_m, p) => {
      sent.push(p);
      return { state: "Completed", result: { image: PNG_B64 }, gatewayMetadata: { keySource: "Unified" } };
    });
    const body = (await res.json()) as { ok: boolean; output?: { image: { bytes_b64: string; mime: string } } };
    expect(sent).toEqual([{ prompt: PROMPT, response_format: "b64_json" }]);
    expect(body.ok).toBe(true);
    expect(body.output?.image).toEqual({ bytes_b64: PNG_B64, mime: "image/png" });
    expect(checkHookOutput("image.generate", body.output).pass).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("recraft/recraftv4 sends no style (cf#1141)", () => {
  const schema = loadSchema("recraftv4.schema-input.json");

  it("sends prompt and size only, and the published schema accepts it", () => {
    const body = proxiedParams("recraft/recraftv4", PROMPT);
    expect(body).toEqual({ prompt: PROMPT, size: "1024x1024" });
    expect("style" in body).toBe(false);
    expect(violations(schema, body)).toEqual([]);
  });

  it("the invoke path sends that same body to the binding", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0)), {
      headers: { "content-type": "image/png" },
    })));
    const sent: unknown[] = [];
    const res = await invoke("recraft/recraftv4", async (_m, p) => {
      sent.push(p);
      return { state: "Completed", result: { image: "https://example.invalid/recraft.png" } };
    });
    const body = (await res.json()) as { ok: boolean };
    expect(sent).toEqual([{ prompt: PROMPT, size: "1024x1024" }]);
    expect(body.ok).toBe(true);
  });
});

describe("proxiedImageBytes reads a URL, a data: URL or raw base64", () => {
  it("decodes raw base64 and sniffs the mime", async () => {
    const r = await proxiedImageBytes(PNG_B64);
    expect(r.mime).toBe("image/png");
    expect(r.bytes[0]).toBe(0x89);
  });

  it("decodes a data: URL", async () => {
    const r = await proxiedImageBytes(`data:image/png;base64,${PNG_B64}`);
    expect(r.mime).toBe("image/png");
    expect(r.bytes.length).toBeGreaterThan(8);
  });

  it("fetches an https URL", async () => {
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      headers: { "content-type": "image/jpeg" },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await proxiedImageBytes("https://example.invalid/a.jpg");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.mime).toBe("image/jpeg");
  });

  it("sniffs a fetched WebP even when the header says image/png (cf#1294)", async () => {
    // RIFF....WEBP: the magic of the Recraft V4 artifact read live on 2026-11-06 (52494646).
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(webp, { headers: { "content-type": "image/png" } })));
    const r = await proxiedImageBytes("https://example.invalid/recraft.png");
    expect(r.mime).toBe("image/webp");
  });

  it("sniffs a fetched GIF as image/gif, not the png default", async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(gif)));
    const r = await proxiedImageBytes("https://example.invalid/a.gif");
    expect(r.mime).toBe("image/gif");
  });

  it("keeps the header when the fetched magic is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), {
      headers: { "content-type": "image/avif" },
    })));
    const r = await proxiedImageBytes("https://example.invalid/a.avif");
    expect(r.mime).toBe("image/avif");
  });

  it("fails loud on text that is neither", async () => {
    await expect(proxiedImageBytes("not an image, at all!")).rejects.toThrow("neither a URL nor base64");
  });

  it("fails loud on valid base64 that decodes to something other than an image", async () => {
    // "notanimage" is valid base64 text. Decoding it is not the same as getting a picture.
    await expect(proxiedImageBytes("notanimageatall")).rejects.toThrow("base64 that is not an image");
  });
});
