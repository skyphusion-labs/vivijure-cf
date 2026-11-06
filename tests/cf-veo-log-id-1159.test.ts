import { afterEach, describe, expect, it, vi } from "vitest";
import { generateClip, type WorkflowParams } from "../modules/cf-veo/src/index";
import { namingGatewayLog } from "../modules/_shared/gateway-log";

// cf#1159: cf-veo failed one photoreal shot with "AiGatewayError: 2002: Error" and nothing else. The gateway log
// holds the request and the provider's reply; its id holds no content.
const params = {
  job_id: "j", project: "p", shot_id: "s", seconds: 8,
  input: { shot_id: "s", keyframe_url: "https://k/x.png", prompt: "the secret prompt" },
  config: { resolution: "720p", generate_audio: true },
} as unknown as WorkflowParams;

const envWith = (run: () => Promise<unknown>, logId?: string | null) => ({
  GATEWAY_ID: { get: async () => "gw" },
  AI: { run, aiGatewayLogId: logId },
}) as never;

const fail = async () => { throw new Error("AiGatewayError: 2002: Error"); };

describe("cf-veo: a failed provider call", () => {
  afterEach(() => vi.unstubAllGlobals());
  const png = () => vi.stubGlobal("fetch", async () => new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200, headers: { "content-type": "image/png" },
  }));

  it("names the gateway log after the provider code", async () => {
    png();
    await expect(generateClip(envWith(fail, "log-2002"), params)).rejects.toThrow(
      "AiGatewayError: 2002: Error (gateway log log-2002)",
    );
  });
  it("carries no prompt", async () => {
    png();
    const e = await generateClip(envWith(fail, "log-2002"), params).catch((x: Error) => x);
    expect((e as Error).message).not.toContain("secret");
  });
  it("is unchanged with no log id", async () => {
    png();
    await expect(generateClip(envWith(fail, null), params)).rejects.toThrow(/^AiGatewayError: 2002: Error$/);
  });
  it("CONTROL: a good call returns its result", async () => {
    png();
    await expect(generateClip(envWith(async () => ({ video: "v" }), "x"), params)).resolves.toEqual({ video: "v" });
  });
});

describe("namingGatewayLog", () => {
  it("names the log once, even if a caller wraps twice", async () => {
    const ai = { aiGatewayLogId: "L" };
    const e = await namingGatewayLog(ai, () => namingGatewayLog(ai, fail)).catch((x: Error) => x);
    expect((e as Error).message).toBe("AiGatewayError: 2002: Error (gateway log L)");
  });
  it("leaves a non-Error throw alone", async () => {
    await expect(namingGatewayLog({ aiGatewayLogId: "L" }, async () => { throw "raw"; })).rejects.toBe("raw");
  });
});
