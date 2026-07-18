// The image-generate module: conformance + dispatch behaviour (cf#129 phase 2).
//
// The binding acceptance criterion, same as plan-enhance's: the module must honor the typed hook
// contract over its real transport, and its declared models must be what the catalog projects. The
// conformance assertion is the load-bearing one -- a module can be envelope-correct and still return
// a payload the core would hand downstream as garbage.

import { describe, it, expect, vi } from "vitest";
import worker, { MANIFEST, MODELS } from "../modules/image-generate/src/index";
import { checkHookOutput } from "@skyphusion-labs/vivijure-core/modules/conformance";
import { validateManifest } from "@skyphusion-labs/vivijure-core/modules/manifest-validate";
import { base64ToBytes, sniffImageMime } from "../modules/image-generate/src/image-gen";

// A 1x1 PNG, so the bytes that come back are a real image rather than a placeholder string.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function envWith(run: (model: string, params: unknown, opts?: unknown) => Promise<unknown>) {
  return { AI: { run }, GATEWAY_ID: "vivijure" };
}

function invoke(env: unknown, body: unknown) {
  return worker.fetch(
    new Request("https://module.example/invoke", { method: "POST", body: JSON.stringify(body) }),
    env as never,
  );
}

describe("image-generate manifest", () => {
  it("is a VALID manifest by the core's own validator", () => {
    const r = validateManifest(MANIFEST);
    expect(typeof r).not.toBe("string");
  });

  it("serves the manifest on GET /module.json", async () => {
    const res = await worker.fetch(new Request("https://module.example/module.json"), envWith(async () => ({})) as never);
    expect(res.status).toBe(200);
    const m = (await res.json()) as { hooks: string[]; config_schema: Record<string, unknown> };
    expect(m.hooks).toEqual(["image.generate"]);
    expect(m.config_schema.model).toBeTruthy();
  });

  // This is what makes the studio catalog a projection rather than a second hardcoded list.
  it("declares its models in config_schema.model, which is what the catalog projects", () => {
    const field = MANIFEST.config_schema?.model;
    expect(field?.type).toBe("enum");
    expect((field as { values: string[] }).values).toEqual(MODELS);
    expect(MODELS.length).toBeGreaterThan(0);
  });
});

// The installer seeds operator-supplied secrets with a marked placeholder so the module deploy can
// resolve them at all. For an OPTIONAL key that is a trap: a non-empty placeholder reads as
// "configured", so the module would take the BYOK path with a garbage credential and hard-fail,
// instead of degrading to the proxied path. These pin the placeholder as ABSENT.
describe("operator placeholder is treated as an unset secret", () => {
  const PLACEHOLDER = "REPLACE_ME__vivijure-deploy-operator-secret";

  it("does NOT take the OpenAI BYOK path when the key is still the placeholder", async () => {
    const seen: string[] = [];
    const env = {
      AI: { run: async (m: string) => { seen.push(m); return { url: "https://images.example/x.png" }; } },
      OPENAI_API_KEY: PLACEHOLDER,
    };
    // A BYOK attempt would fetch api.openai.com; the proxied path goes through the AI binding.
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200, headers: { "content-type": "image/png" },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await invoke(env, {
      hook: "image.generate",
      input: { prompt: "x" },
      config: { model: "openai/gpt-image-1.5" },
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(seen).toEqual(["openai/gpt-image-1.5"]);
    const calledOpenAI = fetchSpy.mock.calls.some((c) => String(c[0]).includes("api.openai.com"));
    expect(calledOpenAI).toBe(false);
    vi.unstubAllGlobals();
  });

  // POSITIVE CONTROL: a REAL key must still take the BYOK path, or the assertion above would pass
  // simply because the BYOK path never runs under any condition.
  it("control: a real key DOES take the BYOK path", async () => {
    const env = {
      AI: { run: async () => ({ url: "https://images.example/x.png" }) },
      OPENAI_API_KEY: "sk-real-key",
    };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    await invoke(env, {
      hook: "image.generate",
      input: { prompt: "x" },
      config: { model: "openai/gpt-image-1.5" },
    });
    const calledOpenAI = fetchSpy.mock.calls.some((c) => String(c[0]).includes("api.openai.com"));
    expect(calledOpenAI).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("image.generate invoke", () => {
  it("returns a CONFORMANT payload for a plain @cf model", async () => {
    const res = await invoke(envWith(async () => ({ image: PNG_B64 })), {
      hook: "image.generate",
      input: { prompt: "a quiet harbor at dawn" },
      config: { model: "@cf/stabilityai/stable-diffusion-xl-base-1.0" },
    });
    const body = (await res.json()) as { ok: boolean; output?: Record<string, unknown> };
    expect(body.ok).toBe(true);
    // THE conformance gate: the core's own checker must accept this payload.
    expect(checkHookOutput("image.generate", body.output).pass).toBe(true);
  });

  it("returns bytes that are a REAL image, and the mime it sniffed matches them", async () => {
    const res = await invoke(envWith(async () => ({ image: PNG_B64 })), {
      hook: "image.generate",
      input: { prompt: "x" },
      config: { model: "@cf/lykon/dreamshaper-8-lcm" },
    });
    const body = (await res.json()) as { output: { image: { bytes_b64: string; mime: string } } };
    const bytes = base64ToBytes(body.output.image.bytes_b64);
    // Round-trips to the same picture, and the declared mime is what the magic bytes actually say.
    expect(sniffImageMime(bytes).mime).toBe("image/png");
    expect(body.output.image.mime).toBe("image/png");
    expect(body.output.image.bytes_b64.startsWith("data:")).toBe(false);
  });

  it("clamps an unknown model id to the declared default instead of passing it upstream", async () => {
    const seen: string[] = [];
    const res = await invoke(envWith(async (m) => { seen.push(m); return { image: PNG_B64 }; }), {
      hook: "image.generate",
      input: { prompt: "x" },
      config: { model: "acme/not-a-real-model" },
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(seen).toEqual([MODELS[0]]);
  });

  // Image generation has no honest passthrough: there is no previous artifact to return and no such
  // thing as a partially-generated picture, so it fails LOUD rather than soft-degrading.
  it("FAILS LOUD when the model returns no image, naming the model", async () => {
    const res = await invoke(envWith(async () => ({})), {
      hook: "image.generate",
      input: { prompt: "x" },
      config: { model: "@cf/lykon/dreamshaper-8-lcm" },
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("@cf/lykon/dreamshaper-8-lcm");
  });

  it("FAILS LOUD when the provider flags/refuses the generation", async () => {
    const res = await invoke(envWith(async () => ({ error: "content policy" })), {
      hook: "image.generate",
      input: { prompt: "x" },
      config: { model: "google/nano-banana-pro" },
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("content policy");
  });

  it("rejects an empty prompt rather than generating something arbitrary", async () => {
    const res = await invoke(envWith(async () => ({ image: PNG_B64 })), {
      hook: "image.generate",
      input: { prompt: "   " },
      config: {},
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("rejects a request for a hook it does not serve", async () => {
    const res = await invoke(envWith(async () => ({ image: PNG_B64 })), {
      hook: "plan.enhance",
      input: { prompt: "x" },
      config: {},
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("plan.enhance");
  });

  // Guards the SDXL/schnell param quirks that were learned from real failures: sending the wrong
  // step key is silently ignored upstream, which reads as "worked" and produces a worse image.
  it("sends SDXL num_steps and schnell 4 steps with no negative prompt", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const env = envWith(async (_m, params) => { calls.push(params as Record<string, unknown>); return { image: PNG_B64 }; });
    await invoke(env, { hook: "image.generate", input: { prompt: "x", negative_prompt: "blurry" }, config: { model: "@cf/stabilityai/stable-diffusion-xl-base-1.0" } });
    await invoke(env, { hook: "image.generate", input: { prompt: "x", negative_prompt: "blurry" }, config: { model: "@cf/black-forest-labs/flux-1-schnell" } });
    expect(calls[0].num_steps).toBe(20);
    expect(calls[0].steps).toBeUndefined();
    expect(calls[1].steps).toBe(4);
    expect(calls[1].negative_prompt).toBeUndefined();
  });
});
