import { describe, expect, it } from "vitest";
import { buildParams, normalizeConfig } from "../modules/cf-seedance/src/params";

const shot = {
  shot_id: "s1",
  keyframe_url: "https://r2/still.png",
  prompt: "SPOKEN LINE: \"Hello.\"",
  seconds: 6,
  voice_ref_url: "https://r2/voice-sample.mp4",
};

describe("cf-seedance voice sample lock", () => {
  it("sends the Cast preview as reference_videos on the default model (2.5)", () => {
    const p = buildParams(shot, normalizeConfig({}));
    expect(p.reference_videos).toEqual(["https://r2/voice-sample.mp4"]);
    expect(p.reference_video).toBeUndefined();
    expect(p.reference_audios).toBeUndefined();
    expect(String(p.prompt)).toMatch(/reference video/);
    expect(p.generate_audio).toBe(true);
  });

  it("sends the Cast preview as reference_video on the 2.0 family", () => {
    for (const model of ["bytedance/seedance-2.0", "bytedance/seedance-2.0-fast", "bytedance/seedance-2.0-mini"]) {
      const p = buildParams(shot, normalizeConfig({ model }));
      expect(p.reference_video).toBe("https://r2/voice-sample.mp4");
      expect(p.reference_videos).toBeUndefined();
      expect(p.reference_audio).toBeUndefined();
    }
  });

  it("omits both voice fields when no sample was kept", () => {
    const p = buildParams({
      shot_id: "s1",
      keyframe_url: "https://r2/still.png",
      prompt: "walks",
      seconds: 6,
    }, normalizeConfig({}));
    expect(p.reference_video).toBeUndefined();
    expect(p.reference_videos).toBeUndefined();
  });
});
