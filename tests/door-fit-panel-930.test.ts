/// <reference types="node" />
// vivijure-cf#930: the panel reads core's `door_fit` render signal (core 1.47.0, door-fit.ts). Core moves a
// lined shot off a film door whose clip floor would leave the speaker mouthing silence after the line, for
// that one clip (Conrad's ruling 2026-11-11), or records the tail. Both are shown, because both mean the
// clip is not what the film door alone would have made. The ladder holds: absent shows nothing, empty
// lists are clean, junk is unreadable and quiet.
import { describe, expect, it } from "vitest";
import * as fd from "../public/finish-degrade.js";
import type { RenderOutput } from "../public/finish-degrade.js";

const { DEGRADE_BANDS, stageBand, stageFrom, stageSummary, stagesNote } = fd;

const record = {
  swapped: [{ shot_id: "shot_01", from: "alibaba-wan", to: "infinitetalk", line_seconds: 1.4, planned_seconds: 2, from_clip_seconds: 5 }],
  tails: [{ shot_id: "shot_03", door: "alibaba-wan", line_seconds: 1, clip_seconds: 5 }],
};

describe("the panel shows door_fit (cf#930)", () => {
  it("ABSENT is unmeasured and shows nothing; a witness stage in the same payload does render", () => {
    const out = { plate_check: { checked: 1, unclean: [{ shot_id: "s1", expected: 1, faces: 2 }] } } as unknown as RenderOutput;
    expect(stageBand(out, "door_fit")).toBe(DEGRADE_BANDS.UNMEASURED);
    expect(stageFrom(out, "door_fit")).toBeNull();
    expect(stageFrom(out, "plate_check")).not.toBeNull();
  });

  it("empty lists are NONE-REPORTED and show nothing", () => {
    const out = { door_fit: { swapped: [], tails: [] } } as unknown as RenderOutput;
    expect(stageBand(out, "door_fit")).toBe(DEGRADE_BANDS.NONE_REPORTED);
    expect(stageFrom(out, "door_fit")).toBeNull();
  });

  it("a moved shot and a tail both render, each in plain words naming the shot, the doors and the lengths", () => {
    const out = { door_fit: record } as unknown as RenderOutput;
    expect(stageBand(out, "door_fit")).toBe(DEGRADE_BANDS.REPORTED);
    const info = stageFrom(out, "door_fit")!;
    expect(info.degraded).toBe(2);
    const text = stageSummary(info)!;
    expect(text).toContain("shot_01 was made on infinitetalk, not alibaba-wan: its 1.4 s line is shorter than the 5 s clip alibaba-wan makes");
    expect(text).toContain("shot_03: its 1 s line ends before the 5 s clip on alibaba-wan, so the speaker keeps mouthing words after it.");
    expect(stagesNote([info])).not.toBeNull();
  });

  it("a malformed record is UNREADABLE, never clean, and stays quiet", () => {
    const out = { door_fit: { swapped: "x" } } as unknown as RenderOutput;
    expect(stageBand(out, "door_fit")).toBe(DEGRADE_BANDS.UNREADABLE);
    expect(stageFrom(out, "door_fit")).toBeNull();
  });
});
