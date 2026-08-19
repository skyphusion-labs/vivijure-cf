import { describe, expect, it } from "vitest";
import { doorCanSpeakLines, isTalkingClip } from "../src/motion-scatter";

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
