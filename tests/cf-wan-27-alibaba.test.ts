import { describe, expect, it } from "vitest";
import { buildAlibabaMedia, buildParams, normalizeConfig } from "../modules/cf-wan-27/src/params";

const shot = {
  shot_id: "shot_02",
  keyframe_url: "https://r2/first.png",
  prompt: "Mara says hello.",
  seconds: 5,
};

describe("cf-wan-27 Alibaba media passthrough", () => {
  it("always sends first_frame plus CF image", () => {
    const media = buildAlibabaMedia(shot);
    expect(media).toEqual([{ type: "first_frame", url: "https://r2/first.png" }]);
    const p = buildParams(shot, normalizeConfig({}));
    expect(p.image).toBe("https://r2/first.png");
    expect(p.media).toEqual(media);
    expect(p.last_frame).toBeUndefined();
    expect(p.driving_audio).toBeUndefined();
  });

  it("adds last_frame when the next still exists", () => {
    const p = buildParams(
      { ...shot, last_keyframe_url: "https://r2/last.png" },
      normalizeConfig({}),
    );
    expect(p.media).toEqual([
      { type: "first_frame", url: "https://r2/first.png" },
      { type: "last_frame", url: "https://r2/last.png" },
    ]);
    expect(p.last_frame).toBe("https://r2/last.png");
  });

  it("adds driving_audio from the Cast voice sample (Alibaba lip-sync)", () => {
    const p = buildParams(
      { ...shot, voice_ref_url: "https://r2/cast/18/voice-ref.mp4" },
      normalizeConfig({}),
    );
    expect(p.media).toContainEqual({ type: "driving_audio", url: "https://r2/cast/18/voice-ref.mp4" });
    expect(p.driving_audio).toBe("https://r2/cast/18/voice-ref.mp4");
  });

  it("sends first + last + driving_audio together", () => {
    const p = buildParams(
      {
        ...shot,
        last_keyframe_url: "https://r2/last.png",
        voice_ref_url: "https://r2/line.wav",
      },
      normalizeConfig({}),
    );
    expect(p.media).toEqual([
      { type: "first_frame", url: "https://r2/first.png" },
      { type: "last_frame", url: "https://r2/last.png" },
      { type: "driving_audio", url: "https://r2/line.wav" },
    ]);
  });
});
