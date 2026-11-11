import { describe, expect, it } from "vitest";
import { buildParams, keyframeImageInput, normalizeConfig } from "../modules/cf-veo/src/params";

// The provider decodes image_input as base64. A presigned URL failed with 2002, and a data URI failed
// with "Invalid base64 encoded bytes" (AI Gateway logs, 2026-10-30). These pin the shape we send. They
// cannot prove the provider accepts it: only a real render does that.

const INPUT = { shot_id: "s", keyframe_url: "https://r2.example/k.png?X-Amz-Signature=secret", prompt: "p", seconds: 6 };
const png = (type = "image/png") =>
  async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": type } });

describe("cf-veo image_input", () => {
  it("is bare base64 of the fetched bytes, with no data: prefix", async () => {
    const out = await keyframeImageInput(INPUT.keyframe_url, png("image/jpeg; charset=x"));
    expect(out).toBe("AQID");
    expect(out).not.toMatch(/^data:/);
  });

  it("encodes a keyframe far larger than one chunk", async () => {
    const big = new Uint8Array(200_000).fill(7);
    const uri = await keyframeImageInput(INPUT.keyframe_url, async () => new Response(big, { status: 200 }));
    expect(atob(uri).length).toBe(200_000);
  });

  it("fails on a bad fetch, without the presigned URL in the message", async () => {
    const run = keyframeImageInput(INPUT.keyframe_url, async () => new Response("", { status: 403 }));
    await expect(run).rejects.toThrow("keyframe fetch 403");
    await expect(run).rejects.not.toThrow("secret");
  });

  it("buildParams sends what it is given and only fields in the schema, never the URL", () => {
    const params = buildParams(INPUT, normalizeConfig({}), "AQID");
    expect(params.image_input).toBe("AQID");
    expect(JSON.stringify(params)).not.toContain("r2.example");
    expect(Object.keys(params).sort()).toEqual(["aspect_ratio", "duration", "generate_audio", "image_input", "prompt", "resolution"]);
    expect(params.duration).toBe("6s");
  });
});
