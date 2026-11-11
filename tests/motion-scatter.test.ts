import { describe, expect, it } from "vitest";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import {
  doorCanSpeakLines,
  hostedMotionFallback,
  hostedSilentDoor,
  hostedSpokenDoor,
  isDrivingOnlyDoor,
  isSilentCatalogDoor,
  isTalkingClip,
  prepareSpokenClip,
} from "../src/motion-scatter";

function door(name: string, usage: Record<string, unknown>, locality = "cloud", schema?: Record<string, unknown>): RegisteredModule {
  return {
    name,
    hooks: ["motion.backend"],
    ui: { locality, order: 10 },
    usage,
    config_schema: schema ?? {},
  } as unknown as RegisteredModule;
}

describe("doorCanSpeakLines", () => {
  it("treats native_audio and driving_audio as speaking", () => {
    expect(doorCanSpeakLines({ usage: { native_audio: true } })).toBe(true);
    expect(doorCanSpeakLines({ usage: { driving_audio: true } })).toBe(true);
    expect(doorCanSpeakLines({ usage: { native_audio: false, driving_audio: true } })).toBe(true);
    expect(doorCanSpeakLines({ usage: { native_audio: false } })).toBe(false);
    expect(doorCanSpeakLines(undefined)).toBe(false);
  });

  it("isTalkingClip requires generate_audio on as well", () => {
    const talk = { usage: { native_audio: false, driving_audio: true } };
    expect(isTalkingClip(talk, true)).toBe(true);
    expect(isTalkingClip(talk, false)).toBe(false);
  });
});

describe("hosted spoken and silent doors", () => {
  const infinitetalk = door("infinitetalk", { native_audio: false, driving_audio: true });
  const otherDrive = door("other-drive", { native_audio: false, driving_audio: true });
  const wan = door("alibaba-wan", { native_audio: true, driving_audio: true });
  const ownGpu = door("own-gpu", { native_audio: false }, "byo");
  const hailuo = door("cf-hailuo", { native_audio: false });
  const seedance = door("cf-seedance", { native_audio: true });

  it("InfiniteTalk is driving-only and Wan is not", () => {
    expect(isDrivingOnlyDoor(infinitetalk)).toBe(true);
    expect(isDrivingOnlyDoor(wan)).toBe(false);
    expect(isSilentCatalogDoor(hailuo)).toBe(true);
    expect(isSilentCatalogDoor(infinitetalk)).toBe(false);
  });

  it("prefers infinitetalk over another driving-only cloud door, and skips Wan and own-gpu", () => {
    expect(hostedSpokenDoor([otherDrive, wan, ownGpu, infinitetalk])?.name).toBe("infinitetalk");
    expect(hostedSpokenDoor([otherDrive, wan, ownGpu])?.name).toBe("other-drive");
    expect(hostedSpokenDoor([wan, ownGpu])).toBeUndefined();
  });

  it("silent default is the catalog door, not a talking door and not own-gpu", () => {
    expect(hostedSilentDoor([infinitetalk, wan, ownGpu, seedance, hailuo])?.name).toBe("cf-hailuo");
    expect(hostedSilentDoor([infinitetalk, wan, ownGpu])).toBeUndefined();
  });

  it("an omitted spoken backend names infinitetalk, and an omitted silent backend names hailuo", () => {
    const mods = [ownGpu, wan, seedance, hailuo, infinitetalk];
    expect(hostedMotionFallback(mods, undefined, true)).toEqual({ name: "infinitetalk" });
    expect(hostedMotionFallback(mods, "cf-seedance", true)).toEqual({ name: "cf-seedance" });
    expect(hostedMotionFallback(mods, undefined, false)).toEqual({ name: "cf-hailuo" });
  });

  it("a spoken driving-only clip drops the voice sample and forces generate_audio off when declared", () => {
    const withKnob = door("infinitetalk", { native_audio: false, driving_audio: true }, "cloud", {
      generate_audio: { type: "bool" },
    });
    const prepared = prepareSpokenClip(
      [withKnob],
      withKnob,
      { generate_audio: true },
      { shot_01: "cast/1/voice-ref.mp4" },
      true,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.config).toEqual({ generate_audio: false });
    expect(prepared.voiceRefs).toBeUndefined();
  });

  it("a spoken driving-only clip does not invent generate_audio when the schema has no such key", () => {
    const prepared = prepareSpokenClip(
      [infinitetalk],
      infinitetalk,
      { enable_safety_checker: false },
      { shot_01: "cast/1/voice-ref.mp4" },
      true,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.config).toEqual({ enable_safety_checker: false });
    expect(prepared.voiceRefs).toBeUndefined();
  });

  it("a native-audio door with talking audio off is still refused", () => {
    const prepared = prepareSpokenClip([seedance], seedance, { generate_audio: false }, { shot_01: "k" }, true);
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error).toMatch(/talking audio/i);
  });

  it("a silent look door with a line is still refused", () => {
    const prepared = prepareSpokenClip([hailuo, seedance], hailuo, {}, undefined, true);
    expect(prepared.ok).toBe(false);
  });
});
