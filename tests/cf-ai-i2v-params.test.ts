import { describe, it, expect } from "vitest";

import * as hh1 from "../modules/cf-hh1-r2v/src/params";
import * as seedance from "../modules/cf-seedance/src/params";
import * as grok from "../modules/cf-grok-video/src/params";
import * as flux from "../modules/cf-flux-3-video/src/params";

const shot = {
  shot_id: "shot_01",
  keyframe_url: "https://r2.example/k.png",
  prompt: "slow camera push-in",
  seconds: 5,
};

describe("cf-hh1-r2v params", () => {
  it("buildParams puts keyframe into images[] and clamps duration", () => {
    const p = hh1.buildParams(shot, hh1.normalizeConfig({ resolution: "1080P", ratio: "9:16" }));
    expect(p).toMatchObject({
      prompt: "slow camera push-in",
      images: ["https://r2.example/k.png"],
      duration: 5,
      resolution: "1080P",
      ratio: "9:16",
    });
  });
  it("clampDuration is [3,15]", () => {
    expect(hh1.clampDuration(1)).toBe(3);
    expect(hh1.clampDuration(20)).toBe(15);
  });
  it("omits seed when -1", () => {
    const p = hh1.buildParams(shot, hh1.normalizeConfig({ seed: -1 }));
    expect(p.seed).toBeUndefined();
  });
  it("parseVideoUrl reads CF result.video", () => {
    expect(hh1.parseVideoUrl({ state: "Completed", result: { video: "https://cdn/x.mp4" } })).toBe("https://cdn/x.mp4");
    expect(hh1.parseVideoUrl({ state: "Running" })).toBeNull();
  });
  it("poll + keys round-trip", () => {
    expect(hh1.decodePoll(hh1.encodePoll({ job_id: "j1" }))).toEqual({ job_id: "j1" });
    expect(hh1.stateKey("j1")).toBe("cf-hh1-r2v/j1.state.json");
    expect(hh1.clipKey("My P!", "s 1")).toBe("renders/My_P_/clips/s_1_cf-hh1-r2v.mp4");
  });
});

describe("cf-seedance params", () => {
  it("buildParams matches Seedance 2.0 i2v shape (prism longrun-params)", () => {
    const cfg = seedance.normalizeConfig({ model: "bytedance/seedance-2.0-fast", resolution: "1080p" });
    const p = seedance.buildParams(shot, cfg);
    expect(p).toMatchObject({
      image: "https://r2.example/k.png",
      prompt: "slow camera push-in",
      duration: 5,
      resolution: "1080p",
      fps: 24,
      camera_fixed: false,
      watermark: false,
      generate_audio: false,
    });
    expect(seedance.selectedModel(cfg)).toBe("bytedance/seedance-2.0-fast");
  });
  it("clampDuration is [4,12]", () => {
    expect(seedance.clampDuration(1)).toBe(4);
    expect(seedance.clampDuration(99)).toBe(12);
  });
  it("falls back to default model on junk", () => {
    expect(seedance.normalizeConfig({ model: "nope" }).model).toBe("bytedance/seedance-2.0");
  });
});

describe("cf-grok-video params", () => {
  it("buildParams wraps keyframe as image.url object", () => {
    const p = grok.buildParams(shot, grok.normalizeConfig({}));
    expect(p).toMatchObject({
      prompt: "slow camera push-in",
      duration: 5,
      resolution: "720p",
      aspect_ratio: "16:9",
      image: { url: "https://r2.example/k.png" },
    });
  });
  it("clampDuration is [1,15] (0/NaN snap to default 5 like other modules)", () => {
    expect(grok.clampDuration(0)).toBe(5);
    expect(grok.clampDuration(1)).toBe(1);
    expect(grok.clampDuration(30)).toBe(15);
  });
});

describe("cf-flux-3-video params", () => {
  it("buildParams uses mode=i2v with image start frame", () => {
    const p = flux.buildParams(shot, flux.normalizeConfig({ resolution: "fhd" }));
    expect(p).toMatchObject({
      mode: "i2v",
      prompt: "slow camera push-in",
      image: "https://r2.example/k.png",
      resolution: "fhd",
      generate_audio: false,
    });
    expect(p.duration).toBe(5);
  });
  it("clampDuration prefers 5/10/15/20 steps", () => {
    expect(flux.clampDuration(6)).toBe(5);
    expect(flux.clampDuration(11)).toBe(10);
    expect(flux.clampDuration(3)).toBe(5);
    expect(flux.clampDuration(25)).toBe(20);
  });
});
