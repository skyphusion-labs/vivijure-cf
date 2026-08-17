import { describe, expect, it } from "vitest";
import { buildParams, normalizeConfig } from "../modules/cf-hh1-r2v/src/params.js";

describe("cf-hh1-r2v first+last", () => {
  const cfg = normalizeConfig({});

  it("one still is images[0]", () => {
    const p = buildParams({
      shot_id: "s1",
      keyframe_url: "https://r2.example/a.png",
      prompt: "walk",
      seconds: 5,
    }, cfg);
    expect(p.images).toEqual(["https://r2.example/a.png"]);
  });

  it("next-shot still is images[1]", () => {
    const p = buildParams({
      shot_id: "s1",
      keyframe_url: "https://r2.example/a.png",
      last_keyframe_url: "https://r2.example/b.png",
      prompt: "walk",
      seconds: 5,
    }, cfg);
    expect(p.images).toEqual(["https://r2.example/a.png", "https://r2.example/b.png"]);
  });
});
