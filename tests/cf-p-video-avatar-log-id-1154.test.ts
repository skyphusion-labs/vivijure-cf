import { describe, expect, it } from "vitest";
import { generateClip, type WorkflowParams } from "../modules/cf-p-video-avatar/src/index";

// cf#1154: a provider 7003 carries no detail. The gateway log id points at the request and holds no content.
const params = {
  job_id: "j", project: "p", shot_id: "s",
  input: { shot_id: "s", keyframe_url: "https://k/x.png", prompt: "the secret prompt", audio_url: "https://a/x.wav" },
  config: { resolution: "720p" },
} as unknown as WorkflowParams;

const envWith = (run: () => Promise<unknown>, logId?: string | null) => ({
  GATEWAY_ID: { get: async () => "gw" },
  AI: { run, aiGatewayLogId: logId },
}) as never;

const fail = async () => { throw new Error("7003: User Input Error"); };

describe("a failed provider call", () => {
  it("names the gateway log, and keeps the code the retry classifier reads", async () => {
    await expect(generateClip(envWith(fail, "log-123"), params)).rejects.toThrow(
      "7003: User Input Error (gateway log log-123)",
    );
  });
  it("carries no prompt", async () => {
    const e = await generateClip(envWith(fail, "log-123"), params).catch((x: Error) => x);
    expect((e as Error).message).not.toContain("secret");
  });
  it("is unchanged with no log id", async () => {
    await expect(generateClip(envWith(fail, null), params)).rejects.toThrow(/^7003: User Input Error$/);
  });
  it("CONTROL: a good call returns its result", async () => {
    await expect(generateClip(envWith(async () => ({ video: "v" }), "x"), params)).resolves.toEqual({ video: "v" });
  });
});
