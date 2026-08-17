import { describe, expect, it } from "vitest";
import { buildParams, normalizeConfig } from "../modules/cf-flux-3-video/src/params.js";

describe("cf-flux-3-video first+last + native audio", () => {
  const cfg = normalizeConfig({});

  it("defaults generate_audio on", () => {
    expect(cfg.generate_audio).toBe(true);
  });

  it("one still is a URL string", () => {
    const p = buildParams({
      shot_id: "s1",
      keyframe_url: "https://r2.example/a.png",
      prompt: "walk",
      seconds: 5,
    }, cfg);
    expect(p.keyframes).toBe("https://r2.example/a.png");
    expect(p.generate_audio).toBe(true);
  });

  it("next-shot still becomes a two-url keyframes array", () => {
    const p = buildParams({
      shot_id: "s1",
      keyframe_url: "https://r2.example/a.png",
      last_keyframe_url: "https://r2.example/b.png",
      prompt: "walk",
      seconds: 5,
    }, cfg);
    expect(p.keyframes).toEqual(["https://r2.example/a.png", "https://r2.example/b.png"]);
  });
});
