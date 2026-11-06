import { describe, expect, it } from "vitest";
import { parseSetting, parseStylePrefix } from "../modules/cloud-keyframe/src/bundle";
import { composePrompt, sceneWithSetting } from "../modules/cloud-keyframe/src/keyframe";

// vivijure-cf#1145: a shot whose prompt names no place lost the film's place. The storyboard's optional
// `setting` (vivijure-core#435) is said after any shot that does not already say it.
const YAML = [
  'title: "night shift"',
  'full_prompt: "Two adult engineers repair a failed generator in a dim workshop overnight."',
  'style_prefix: "photoreal, 35mm"',
  'setting: "a dim \\"workshop\\" at night"',
  'scenes:',
  '  - prompt: "Mara wipes grease from her hands and frowns at a gauge."',
].join("\n");

describe("cloud-keyframe reads the board's setting", () => {
  it("parses it, unescaped", () => {
    expect(parseSetting(YAML)).toBe('a dim "workshop" at night');
  });
  it("is empty when the board has none", () => {
    expect(parseSetting(YAML.replace(/^setting:.*$/m, ""))).toBe("");
  });
  it("does not read a scene line or full_prompt as the setting", () => {
    expect(parseSetting('full_prompt: "x"\nscenes:\n  - setting: "not top level"')).toBe("");
  });
  it("style_prefix parsing is unchanged", () => {
    expect(parseStylePrefix(YAML)).toBe("photoreal, 35mm");
  });
});

describe("sceneWithSetting", () => {
  it("adds the setting to a shot that names no place", () => {
    expect(sceneWithSetting("Mara frowns at a gauge.", "a dim workshop at night"))
      .toBe("Mara frowns at a gauge. Setting: a dim workshop at night.");
  });
  it("adds a full stop when the shot has none", () => {
    expect(sceneWithSetting("Mara frowns", "a dim workshop")).toBe("Mara frowns. Setting: a dim workshop.");
  });
  it("leaves a shot that already says it alone, ignoring case", () => {
    expect(sceneWithSetting("Mara walks into A Dim Workshop.", "a dim workshop")).toBe("Mara walks into A Dim Workshop.");
  });
  it("leaves the shot alone when the style prefix already says it", () => {
    expect(sceneWithSetting("Mara frowns.", "a dim workshop", "photoreal, a dim workshop at night")).toBe("Mara frowns.");
  });
  it("is a no-op with no setting", () => {
    expect(sceneWithSetting("  Mara frowns. ", "")).toBe("Mara frowns.");
    expect(sceneWithSetting("Mara frowns.", "   ")).toBe("Mara frowns.");
  });
  it("gives an empty shot the setting alone", () => {
    expect(sceneWithSetting("", "a hilltop")).toBe("Setting: a hilltop.");
  });
  it("reaches the composed prompt before the identity text", () => {
    const p = composePrompt("photoreal", sceneWithSetting("Mara frowns.", "a dim workshop"), ["A"],
      { A: { name: "Mara", prompt: "dark curls", image: "x.png" } });
    expect(p.indexOf("Setting: a dim workshop.")).toBeGreaterThan(p.indexOf("Mara frowns."));
    expect(p.indexOf("Setting: a dim workshop.")).toBeLessThan(p.indexOf("Featuring Mara"));
  });
});
