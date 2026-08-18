import { describe, expect, it } from "vitest";
import {
  sniffVoiceRefMime,
  TALKING_VOICE_HONOR,
  voiceRefKeysFromScenes,
} from "../src/cast-voice-sample";

function ftypMp4(): Uint8Array {
  const b = new Uint8Array(32);
  b[4] = 0x66; b[5] = 0x74; b[6] = 0x79; b[7] = 0x70;
  return b;
}

describe("voiceRefKeysFromScenes", () => {
  it("maps a talking shot to the kept sample for that slot", () => {
    expect(voiceRefKeysFromScenes(
      [{ shot_id: "shot_01", dialogue: { slot: "A", text: "Hello." } }],
      { A: "cast/1/voice-ref.mp4" },
    )).toEqual({ shot_01: "cast/1/voice-ref.mp4" });
  });

  it("skips silent shots and unknown slots", () => {
    expect(voiceRefKeysFromScenes(
      [
        { shot_id: "shot_01", dialogue: { slot: "A", text: "  " } },
        { shot_id: "shot_02", dialogue: { slot: "B", text: "Hi." } },
        { shot_id: "shot_03" },
      ],
      { A: "cast/1/voice-ref.mp4" },
    )).toBeUndefined();
  });
});

describe("sniffVoiceRefMime", () => {
  it("accepts an mp4 ftyp box and a WAV header", () => {
    expect(sniffVoiceRefMime(ftypMp4())).toBe("video/mp4");
    const wav = new Uint8Array(16);
    wav.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffVoiceRefMime(wav)).toBe("audio/wav");
  });

  it("refuses HTML", () => {
    expect(sniffVoiceRefMime(new TextEncoder().encode("<!doctype html>"))).toBeNull();
  });
});

describe("TALKING_VOICE_HONOR", () => {
  it("names Cloudflare Seedance as the exact lock and Veo as neighborhood", () => {
    const seedance = TALKING_VOICE_HONOR.find((d) => d.name === "cf-seedance");
    const veo = TALKING_VOICE_HONOR.find((d) => d.name === "cf-veo");
    expect(seedance?.honor).toBe("exact");
    expect(veo?.honor).toBe("neighborhood");
    expect(veo?.label).toMatch(/not the same take/i);
  });
});
