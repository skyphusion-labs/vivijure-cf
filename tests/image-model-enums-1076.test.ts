import { MODELS as KEYFRAME_MODELS, clampModel } from "../modules/cloud-keyframe/src/keyframe";
// cf#1076: image model enums against schema-input.json, read 2026-10-30.
// Defaults stay the first declared id. A new option is selectable. It is not the default.
import { describe, expect, it, vi } from "vitest";
import { LEGACY_MODELS, MODELS as IMAGE_MODELS } from "../modules/image-generate/src/index";
import { generateImageBytes, proxiedParams as imageParams } from "../modules/image-generate/src/image-gen";
import { MODELS as CAST_MODELS } from "../modules/cast-image/src/index";
import { proxiedParams as castParams } from "../modules/cast-image/src/image-gen";
import { MODELS as KF_MODELS } from "../modules/cloud-keyframe/src/keyframe";
import { maxRefsForModel, proxiedParams as kfParams } from "../modules/cloud-keyframe/src/image-gen";

const refs = (n: number) => Array.from({ length: n }, (_, i) => `data:image/png;base64,${i}`);

describe("cf#1076 image model enums", () => {
  it("does not change the declared default of any image door", () => {
    expect(IMAGE_MODELS[0]).toBe("@cf/black-forest-labs/flux-2-klein-9b");
    expect(CAST_MODELS[0]).toBe("@cf/black-forest-labs/flux-2-klein-9b");
    expect(KF_MODELS[0]).toBe("google/nano-banana-2");
  });

  it("takes imagen-4 off the picker, keeps it runnable, and offers gpt-image-2", () => {
    expect(IMAGE_MODELS).not.toContain("google/imagen-4");
    expect(LEGACY_MODELS).toContain("google/imagen-4");
    expect(IMAGE_MODELS).toContain("openai/gpt-image-2");
    expect(IMAGE_MODELS).not.toContain("openai/gpt-image-1.5");
    expect(LEGACY_MODELS).toContain("openai/gpt-image-1.5");
  });

  it("adds the four testing models on the doors the issue names", () => {
    expect(KF_MODELS).toContain("google/nano-banana-2.1");
    expect(KF_MODELS).toContain("pruna/p-image-edit");
    expect(CAST_MODELS).toContain("black-forest-labs/flux-3-image-klein");
    expect(IMAGE_MODELS).toContain("bytedance/seedream-5-lite");
  });

  it("gpt-image-2 proxy body is the schema fields, with no background", () => {
    const p = imageParams("openai/gpt-image-2", "p", refs(20));
    expect(Object.keys(p).sort()).toEqual(["images", "prompt", "quality", "size"]);
    expect(p.images).toHaveLength(16);
    expect(p).not.toHaveProperty("background");
    expect(p).not.toHaveProperty("output_format");
  });

  it("a key does not send gpt-image-2 down the legacy transparent path", async () => {
    const seen: string[] = [];
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200, headers: { "content-type": "image/png" },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    await generateImageBytes(
      {
        AI: { run: async (m: string) => { seen.push(m); return { url: "https://images.example/x.png" }; } },
        OPENAI_API_KEY: "sk-real-key",
      },
      { model: "openai/gpt-image-2", prompt: "p" },
    );
    expect(seen).toEqual(["openai/gpt-image-2"]);
    const calls = fetchSpy.mock.calls as unknown as unknown[][];
    expect(calls.some((c) => String(c[0]).includes("api.openai.com"))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("seedream-5-lite sends image_input capped at 14 and no other keys", () => {
    const p = imageParams("bytedance/seedream-5-lite", "p", refs(15));
    expect(Object.keys(p).sort()).toEqual(["image_input", "prompt"]);
    expect(p.image_input).toHaveLength(14);
  });

  it("flux-3-image-klein sends images capped at 10 and no other keys", () => {
    const p = castParams("black-forest-labs/flux-3-image-klein", "p", refs(11));
    expect(Object.keys(p).sort()).toEqual(["images", "prompt"]);
    expect(p.images).toHaveLength(10);
    expect(castParams("black-forest-labs/flux-3-image-klein", "p", [])).toEqual({ prompt: "p" });
  });

  it("nano-banana-2.1 keeps the google body and a 3-ref cap", () => {
    const p = kfParams("google/nano-banana-2.1", "p", refs(5), 1344, 768);
    expect(Object.keys(p).sort()).toEqual(["aspect_ratio", "image_input", "output_format", "prompt"]);
    expect(p.image_input).toHaveLength(3);
    expect(p.output_format).toBe("png");
    expect(maxRefsForModel("google/nano-banana-2.1")).toBe(3);
  });

  it("p-image-edit sends the required schema keys and caps images at 5", () => {
    const p = kfParams("pruna/p-image-edit", "p", refs(6), 1344, 768);
    expect(Object.keys(p).sort()).toEqual([
      "aspect_ratio", "disable_safety_checker", "images", "prompt", "turbo",
    ]);
    expect(p.images).toHaveLength(5);
    expect(p.turbo).toBe(true);
    expect(p.aspect_ratio).toBe("match_input_image");
    expect(p.disable_safety_checker).toBe(false);
    expect(maxRefsForModel("pruna/p-image-edit")).toBe(5);
  });
});

describe("cloud-keyframe saved model", () => {
  it("the default is still google/nano-banana-2", () => {
    expect(KEYFRAME_MODELS[0]).toBe("google/nano-banana-2");
  });

  it("honours a saved model that is in MODELS", () => {
    for (const id of KEYFRAME_MODELS) expect(clampModel(id)).toBe(id);
  });

  it("an unknown, stale, or missing saved id falls to the default", () => {
    for (const id of ["google/imagen-4", "not/a-model", "", null, undefined, 7]) {
      expect(clampModel(id)).toBe("google/nano-banana-2");
    }
  });
});
