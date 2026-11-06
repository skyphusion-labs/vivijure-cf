import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSEMBLE_MAX_CLIPS } from "@skyphusion-labs/vivijure-core/assemble-admission";
import { STORYBOARD_MAX_SCENES } from "@skyphusion-labs/vivijure-core/storyboard-validate";

// vivijure-cf#1122. Each cap below is held in two places, and the two must move together.
// core's ASSEMBLE_MAX_CLIPS refuses a film at submit; the container's MAX_CLIPS refuses it at assemble.
// If core's is higher, a film passes submit, buys every clip, and then the container refuses it.
// The panel's PLANNER_MAX_SCENES must equal core's STORYBOARD_MAX_SCENES, or the panel either offers
// boards the validator refuses or refuses boards it would take.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const intConst = (source: string, re: RegExp): number => {
  const m = re.exec(source);
  expect(m, `pattern ${re} not found`).not.toBeNull();
  return Number(m![1].replaceAll("_", ""));
};

describe("caps held equal across core and this repo (vivijure-cf#1122)", () => {
  it("core ASSEMBLE_MAX_CLIPS equals the video-finish container MAX_CLIPS", () => {
    const containerCap = intConst(read("containers/video-finish/app.py"), /^MAX_CLIPS = ([\d_]+)$/m);
    expect(ASSEMBLE_MAX_CLIPS).toBe(containerCap);
  });

  it("the panel PLANNER_MAX_SCENES equals core STORYBOARD_MAX_SCENES", () => {
    const panelCap = intConst(read("public/planner-audio.js"), /^const PLANNER_MAX_SCENES = (\d+);/m);
    expect(panelCap).toBe(STORYBOARD_MAX_SCENES);
  });
});
