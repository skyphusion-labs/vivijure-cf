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

  // cf#954: hh1.1-r2v reads images[] as references, not as an end frame, and two flip-control
  // renders ended on neither still. The door declares no first_last and sends no end still.
  it("a next-shot still is not sent", () => {
    const p = buildParams({
      shot_id: "s1",
      keyframe_url: "https://r2.example/a.png",
      last_keyframe_url: "https://r2.example/b.png",
      prompt: "walk",
      seconds: 5,
    }, cfg);
    expect(p.images).toEqual(["https://r2.example/a.png"]);
  });
});
