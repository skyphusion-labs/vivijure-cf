import { describe, expect, it } from "vitest";
import { missingSdxlForKeyframes, missingSdxlMessage, refusedCast } from "../src/render-door";

describe("missingSdxlForKeyframes", () => {
  it("is empty when every bound slot has an SDXL key", () => {
    expect(missingSdxlForKeyframes(
      { A: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { pretrained: { A: "loras/wren.safetensors" }, speakerNames: { A: "Wren" } },
    )).toEqual([]);
  });

  it("names a Wan-only bind: Wan-train is not a substitute for keyframes", () => {
    const missing = missingSdxlForKeyframes(
      { A: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { pretrained: {}, speakerNames: { A: "Wren" } },
    );
    expect(missing).toEqual([{ slot: "A", name: "Wren" }]);
    expect(missingSdxlMessage(missing)).toMatch(/no SDXL LoRA for keyframes/);
    expect(missingSdxlMessage(missing)).toMatch(/Wan-train is not a substitute/);
    expect(missingSdxlMessage(missing)).toMatch(/Wren/);
  });

  it("ignores an empty bind map (no cast member on the film)", () => {
    expect(missingSdxlForKeyframes({}, { pretrained: {} })).toEqual([]);
    expect(missingSdxlForKeyframes(undefined, { pretrained: {} })).toEqual([]);
  });
});

describe("refusedCast", () => {
  const skipped = [{ slot: "A", reason: "no trained LoRA" }, { slot: "B", reason: "cast member not found" }];

  it("refuses an untrained character on the LoRA door, and when the door is unknown", () => {
    expect(refusedCast(skipped, "keyframe")).toEqual(skipped);
    expect(refusedCast(skipped, undefined)).toEqual(skipped);
  });

  it("does not refuse an untrained character on the door that takes no LoRA", () => {
    expect(refusedCast(skipped, "cloud-keyframe")).toEqual([skipped[1]]);
  });
});
