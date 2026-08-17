import { describe, expect, it } from "vitest";
import { generateAudioOn, isTalkingClip, talkingScatterAllowed } from "../src/motion-scatter";

describe("talkingScatterAllowed", () => {
  it("never scatters talking clips", () => {
    expect(talkingScatterAllowed({
      name: "cf-flux-3-video",
      usage: { native_audio: true, scatter_native_audio: true },
    }, true)).toBe(false);
    expect(talkingScatterAllowed({
      name: "cf-seedance",
      usage: { native_audio: true, scatter_native_audio: true },
    }, true)).toBe(false);
  });

  it("never scatters own-gpu or local-gpu", () => {
    expect(talkingScatterAllowed({
      name: "own-gpu",
      usage: { native_audio: false, scatter_native_audio: true },
    }, true)).toBe(false);
    expect(talkingScatterAllowed({
      name: "local-gpu",
      usage: { native_audio: false, scatter_native_audio: true },
    }, false)).toBe(false);
  });

  it("lets silent cloud scatter when the door says so", () => {
    expect(talkingScatterAllowed({
      name: "kling",
      usage: { native_audio: false, scatter_native_audio: true },
    }, true)).toBe(true);
  });

  it("Flux silent may scatter only if usage says so (Flux talking cannot)", () => {
    expect(talkingScatterAllowed({
      name: "cf-flux-3-video",
      usage: { native_audio: true, scatter_native_audio: false },
    }, false)).toBe(false);
  });
});

describe("isTalkingClip", () => {
  it("silent doors are never talking", () => {
    expect(isTalkingClip({ usage: { native_audio: false } }, true)).toBe(false);
  });
  it("native_audio + generate_audio is talking", () => {
    expect(isTalkingClip({ usage: { native_audio: true } }, true)).toBe(true);
    expect(isTalkingClip({ usage: { native_audio: true } }, false)).toBe(false);
  });
});

describe("generateAudioOn", () => {
  it("defaults on", () => {
    expect(generateAudioOn(undefined)).toBe(true);
    expect(generateAudioOn({})).toBe(true);
    expect(generateAudioOn({ generate_audio: false })).toBe(false);
  });
});
