import { describe, expect, it } from "vitest";
import { buildKlingBody as buildO1, clampDuration as clampO1 } from "../modules/kling-o1-r2v/src/kling";
import { buildKlingBody as buildTalk, clampDuration as clampTalk, framesFromDelivered, mp4DurationSeconds } from "../modules/infinitetalk/src/kling";
import { buildParams as hailuo } from "../modules/cf-hailuo/src/params";
import { buildParams as veo, clampDuration as clampVeo } from "../modules/cf-veo/src/params";
import { chatterboxVoice, buildTtsParams } from "../modules/chatterbox/src/chatterbox";

const shot = { shot_id: "shot_01", keyframe_url: "https://r2/x.png", prompt: "a turn", seconds: 7 };

describe("kling-o1-r2v", () => {
  it("sends images[] and snaps duration up", () => {
    expect(clampO1(4)).toBe(5);
    const b = buildO1({ ...shot, last_keyframe_url: "https://r2/y.png" }, {});
    expect(b.input.images).toEqual(["https://r2/x.png", "https://r2/y.png"]);
    expect(b.input.enable_safety_checker).toBe(false);
  });
});

function tinyMp4(timescale: number, duration: number): Uint8Array {
  const ftypSize = 24;
  const mvhdPayload = 108;
  const mvhdSize = 8 + mvhdPayload;
  const moovSize = 8 + mvhdSize;
  const out = new Uint8Array(ftypSize + moovSize);
  const w32 = (o: number, v: number) => {
    out[o] = (v >>> 24) & 255;
    out[o + 1] = (v >>> 16) & 255;
    out[o + 2] = (v >>> 8) & 255;
    out[o + 3] = v & 255;
  };
  const wcc = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  w32(0, ftypSize); wcc(4, "ftyp"); wcc(8, "isom");
  w32(ftypSize, moovSize); wcc(ftypSize + 4, "moov");
  w32(ftypSize + 8, mvhdSize); wcc(ftypSize + 12, "mvhd");
  w32(ftypSize + 8 + 8 + 12, timescale);
  w32(ftypSize + 8 + 8 + 16, duration);
  return out;
}

describe("infinitetalk", () => {
  it("requires audio and defaults safety off", () => {
    const b = buildTalk(shot, { audio_url: "https://r2/line.wav", size: "720p" });
    expect(b.input).toMatchObject({
      image: "https://r2/x.png",
      audio: "https://r2/line.wav",
      size: "720p",
      enable_safety_checker: false,
    });
    expect(clampTalk(20)).toBe(15);
  });

  it("sends input.audio_url as audio and never a Cast sample field", () => {
    const b = buildTalk({ ...shot, audio_url: "https://r2/line.wav" }, {});
    expect(b.input.audio).toBe("https://r2/line.wav");
    expect(JSON.stringify(b)).not.toMatch(/voice_ref/);
  });

  it("frames follow delivered mp4 duration, else wav seconds", () => {
    const mp4 = tinyMp4(24, 72); // 3s
    expect(mp4DurationSeconds(mp4)).toBeCloseTo(3, 5);
    expect(framesFromDelivered(mp4.buffer as ArrayBuffer, 10, 24)).toBe(72);
    expect(framesFromDelivered(new ArrayBuffer(8), 4, 24)).toBe(96);
  });
});

describe("cf twins", () => {
  it("hailuo uses first_frame_image", () => {
    const p = hailuo(shot, { resolution: "768P", prompt_optimizer: true, fast_pretreatment: false });
    expect(p.first_frame_image).toBe("https://r2/x.png");
    expect(p.duration).toBe(6);
  });
  it("veo uses 4/6/8s and talking audio", () => {
    expect(clampVeo(5)).toBe(4);
    const p = veo(shot, { generate_audio: true, aspect_ratio: "16:9", resolution: "720p" });
    expect(p.image_input).toBe("https://r2/x.png");
    expect(p.duration).toBe("6s");
    expect(p.generate_audio).toBe(true);
  });
});

describe("chatterbox", () => {
  it("maps Aura ids onto Chatterbox presets", () => {
    expect(chatterboxVoice("asteria")).toBe("lucy");
    expect(buildTtsParams("hello", "zeus")).toMatchObject({ prompt: "hello", voice: "walter", format: "wav" });
  });
});
