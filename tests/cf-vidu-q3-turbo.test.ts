// cf#1075: vidu/q3-turbo body matches schema-input.json (2026-10-30).
// required duration + resolution; additionalProperties false; aspect_ratio is text-to-video only.
import { describe, expect, it } from "vitest";
import { buildParams, clampDuration, normalizeConfig, parseVideoUrl, PROMPT_MAX } from "../modules/cf-vidu-q3-turbo/src/params";

const shot = {
  shot_id: "shot_01",
  keyframe_url: "https://r2.example/start.png",
  prompt: "a slow push in",
  seconds: 5,
};

describe("cf-vidu-q3-turbo params follow the published schema", () => {
  it("sends only schema keys, with the still as start_image", () => {
    const p = buildParams(shot, normalizeConfig({}));
    expect(Object.keys(p).sort()).toEqual(["audio", "duration", "prompt", "resolution", "start_image"]);
    expect(p).toEqual({
      prompt: "a slow push in",
      start_image: "https://r2.example/start.png",
      duration: 5,
      resolution: "720p",
      audio: true,
    });
    expect(p).not.toHaveProperty("aspect_ratio");
    expect(p).not.toHaveProperty("image");
    expect(p).not.toHaveProperty("fps");
  });

  it("sends end_image only when the next still is present", () => {
    const p = buildParams(
      { ...shot, last_keyframe_url: "https://r2.example/end.png" },
      normalizeConfig({}),
    );
    expect(p.end_image).toBe("https://r2.example/end.png");
    expect(p.start_image).toBe("https://r2.example/start.png");
  });

  it("clamps duration to the schema integer range 1-16", () => {
    expect(clampDuration(0)).toBe(1);
    expect(clampDuration(0.4)).toBe(1);
    expect(clampDuration(16.6)).toBe(16);
    expect(clampDuration(Number.NaN)).toBe(5);
    const p = buildParams({ ...shot, seconds: 99 }, normalizeConfig({ resolution: "540p", generate_audio: false }));
    expect(p.duration).toBe(16);
    expect(p.resolution).toBe("540p");
    expect(p.audio).toBe(false);
  });

  it("cuts the prompt at the schema maxLength and falls back to 720p on an unknown resolution", () => {
    const long = "x".repeat(PROMPT_MAX + 20);
    const p = buildParams({ ...shot, prompt: long }, normalizeConfig({ resolution: "4k" }));
    expect((p.prompt as string).length).toBe(PROMPT_MAX);
    expect(p.resolution).toBe("720p");
  });

  it("reads result.video and ignores a non-completed state", () => {
    expect(parseVideoUrl({ state: "Completed", result: { video: "https://cdn/x.mp4" } })).toBe("https://cdn/x.mp4");
    expect(parseVideoUrl({ state: "Running", result: { video: "https://cdn/x.mp4" } })).toBeNull();
  });
});
