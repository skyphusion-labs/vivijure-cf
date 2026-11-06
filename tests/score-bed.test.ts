import { describe, it, expect } from "vitest";
import { audioKeyFromApplied, musicScoreModules, narrationScoreModules, scoreModuleLabel } from "../src/score-bed";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";

describe("score-bed helpers", () => {
  it("audioKeyFromApplied reads audio: tags and infers mime", () => {
    expect(
      audioKeyFromApplied(["music:minimax/music-2.6", "audio:out/abc-123.mp3"]),
    ).toEqual({ key: "out/abc-123.mp3", mime: "audio/mpeg" });
    expect(
      audioKeyFromApplied(["audio:out/track.wav"]),
    ).toEqual({ key: "out/track.wav", mime: "audio/wav" });
  });

  it("audioKeyFromApplied returns null when no audio tag", () => {
    expect(audioKeyFromApplied(["music:minimax/music-2.6"])).toBeNull();
    expect(audioKeyFromApplied([])).toBeNull();
  });

  it("musicScoreModules and narrationScoreModules select by declared kind (vivijure-cf#878)", () => {
    const music = {
      name: "music-gen",
      version: "0.1.0",
      api: "vivijure-module/2" as const,
      binding: "MODULE_MUSIC_GEN",
      hooks: ["score" as const],
      score_kind: "music",
      config_schema: { prompt: { type: "string" as const, default: "" } },
    } as unknown as RegisteredModule;
    const narration = {
      name: "narration-gen",
      version: "0.1.0",
      api: "vivijure-module/2" as const,
      binding: "MODULE_NARRATION_GEN",
      hooks: ["score" as const],
      score_kind: "narration",
      config_schema: { text: { type: "string" as const, default: "" } },
    } as unknown as RegisteredModule;
    expect(musicScoreModules([music, narration])).toEqual([music]);
    expect(narrationScoreModules([music, narration])).toEqual([narration]);
    // CONTROL: a module with the old config key and no declared kind is not selected for either.
    const keyOnly = { ...narration, name: "legacy-narration", score_kind: undefined } as unknown as RegisteredModule;
    expect(narrationScoreModules([keyOnly, music])).toEqual([]);
  });

  it("scoreModuleLabel prefers provides[0].label", () => {
    expect(
      scoreModuleLabel({
        name: "music-gen",
        provides: [{ id: "vendor-music", label: "Vendor Music 3" }],
      } as RegisteredModule),
    ).toBe("Vendor Music 3");
    expect(scoreModuleLabel({ name: "custom-music" } as RegisteredModule)).toBe("custom-music");
  });
});
