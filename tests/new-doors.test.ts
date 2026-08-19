import { describe, expect, it } from "vitest";
import { buildKlingBody as buildO1, clampDuration as clampO1 } from "../modules/kling-o1-r2v/src/kling";
import { buildKlingBody as buildTalk, clampDuration as clampTalk } from "../modules/infinitetalk/src/kling";
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
