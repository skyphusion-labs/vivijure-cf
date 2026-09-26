import { describe, expect, it } from "vitest";
import { buildParams, normalizeConfig } from "../modules/cf-seedance/src/params";

describe("cf-seedance voice sample lock", () => {
  it("sends the Cast preview as reference_video", () => {
    const cfg = normalizeConfig({});
    const p = buildParams({
      shot_id: "s1",
      keyframe_url: "https://r2/still.png",
      prompt: "SPOKEN LINE: \"Hello.\"",
      seconds: 6,
      voice_ref_url: "https://r2/voice-sample.mp4",
    }, cfg);
    expect(p.reference_video).toBe("https://r2/voice-sample.mp4");
    expect(String(p.prompt)).toMatch(/reference video/);
    expect(p.generate_audio).toBe(true);
  });

  it("omits reference_video when no sample was kept", () => {
    const p = buildParams({
      shot_id: "s1",
      keyframe_url: "https://r2/still.png",
      prompt: "walks",
      seconds: 6,
    }, normalizeConfig({}));
    expect(p.reference_video).toBeUndefined();
  });
});
