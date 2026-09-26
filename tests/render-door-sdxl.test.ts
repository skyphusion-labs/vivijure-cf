import { describe, expect, it } from "vitest";
import { missingSdxlForKeyframes, missingSdxlMessage } from "../src/render-door";

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
