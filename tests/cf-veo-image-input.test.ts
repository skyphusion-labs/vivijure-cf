import { describe, expect, it } from "vitest";
import { buildParams, keyframeImageInput, normalizeConfig } from "../modules/cf-veo/src/params";

// The model's schema-input.json says image_input is base64. The door sent a presigned URL, and every
// render failed with AiGatewayError 2002. These pin the shape we send. They cannot prove the provider
// accepts it: only a real render does that.

const INPUT = { shot_id: "s", keyframe_url: "https://r2.example/k.png?X-Amz-Signature=secret", prompt: "p", seconds: 6 };
const png = (type = "image/png") =>
  async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": type } });

describe("cf-veo image_input", () => {
  it("is a base64 data URI of the fetched bytes, with the response mime type", async () => {
    expect(await keyframeImageInput(INPUT.keyframe_url, png("image/jpeg; charset=x"))).toBe("data:image/jpeg;base64,AQID");
  });

  it("falls back to image/png when the store sends no image type", async () => {
    expect(await keyframeImageInput(INPUT.keyframe_url, png("binary/octet-stream"))).toBe("data:image/png;base64,AQID");
  });

  it("encodes a keyframe far larger than one chunk", async () => {
    const big = new Uint8Array(200_000).fill(7);
    const uri = await keyframeImageInput(INPUT.keyframe_url, async () => new Response(big, { status: 200 }));
    expect(atob(uri.split(",")[1]).length).toBe(200_000);
  });

  it("fails on a bad fetch, without the presigned URL in the message", async () => {
    const run = keyframeImageInput(INPUT.keyframe_url, async () => new Response("", { status: 403 }));
    await expect(run).rejects.toThrow("keyframe fetch 403");
    await expect(run).rejects.not.toThrow("secret");
  });

  it("buildParams sends what it is given and only fields in the schema, never the URL", () => {
    const params = buildParams(INPUT, normalizeConfig({}), "data:image/png;base64,AQID");
    expect(params.image_input).toBe("data:image/png;base64,AQID");
    expect(JSON.stringify(params)).not.toContain("r2.example");
    expect(Object.keys(params).sort()).toEqual(["aspect_ratio", "duration", "generate_audio", "image_input", "prompt", "resolution"]);
    expect(params.duration).toBe("6s");
  });
});
