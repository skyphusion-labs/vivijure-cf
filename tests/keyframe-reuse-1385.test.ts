/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as fd from "../public/finish-degrade.js";
import type { RenderOutput } from "../public/finish-degrade.js";
import { parseKeyframes as parseLocalGpuKeyframes } from "../modules/local-gpu/src/keyframe";

// cf#1385: the panel says when a still was returned from the store instead of redrawn.
//
// The backend keeps a hash of each still's settings and returns the stored still, marked
// `reused: true`, when the settings are unchanged (vivijure-backend docs/contract.md). Core 1.45.0
// (core#532) carries the mark to the render row: `reused: true` on a keyframe entry, and
// `output.keyframe_reuse {stills, reused}` on the payload, absent when no still was reused. The
// backend also has no random seed (-1 is drawn as 0, vivijure-backend#563), so the panel says how to
// get a new picture. The negative cases each carry a witness: a sibling still in the SAME call that
// IS marked, so "nothing marked" cannot pass by the path never being entered.

const ROOT = join(import.meta.dirname, "..");
const out = (o: Record<string, unknown>) => ({ output_key: "renders/f/film.mp4", ...o }) as RenderOutput;

describe("cf#1385 parseKeyframeReuse: the ladder", () => {
  it("absent, junk and an empty list are null, so a drawn render shows nothing", () => {
    expect(fd.parseKeyframeReuse(undefined)).toBeNull();
    expect(fd.parseKeyframeReuse("junk")).toBeNull();
    expect(fd.parseKeyframeReuse([])).toBeNull();
    expect(fd.parseKeyframeReuse({ stills: 3 })).toBeNull();
    expect(fd.parseKeyframeReuse({ stills: "3", reused: ["a"] })).toBeNull();
    expect(fd.parseKeyframeReuse({ stills: 3, reused: [] })).toBeNull();
    expect(fd.parseKeyframeReuse({ stills: 3, reused: [1, "", null] })).toBeNull();
  });

  it("reads the core shape, drops odd ids and duplicates, and never reports fewer stills than reused", () => {
    expect(fd.parseKeyframeReuse({ stills: 5, reused: ["shot_01", "shot_03"] }))
      .toEqual({ stills: 5, reused: ["shot_01", "shot_03"] });
    expect(fd.parseKeyframeReuse({ stills: 5, reused: ["shot_01", 7, "shot_01", "shot_02"] }))
      .toEqual({ stills: 5, reused: ["shot_01", "shot_02"] });
    expect(fd.parseKeyframeReuse({ stills: 1, reused: ["a", "b"] })).toEqual({ stills: 2, reused: ["a", "b"] });
  });
});

describe("cf#1385 reuseNote: the row line", () => {
  it("says how many stills were reused and how to get a new picture", () => {
    const line = fd.reuseNote(out({ keyframe_reuse: { stills: 5, reused: ["shot_01", "shot_03"] } }));
    expect(line).toBe("2 of 5 stills were reused from an earlier render with the same settings, not redrawn. " + fd.NEW_PICTURE_HINT);
    expect(fd.NEW_PICTURE_HINT).toContain("set a new keyframe seed");
    expect(fd.NEW_PICTURE_HINT).toContain("A seed of -1 draws the same picture every time.");
  });

  it("counts one, all, and a single still in plain words", () => {
    expect(fd.reuseNote(out({ keyframe_reuse: { stills: 4, reused: ["a"] } }))).toMatch(/^1 of 4 stills was reused /);
    expect(fd.reuseNote(out({ keyframe_reuse: { stills: 3, reused: ["a", "b", "c"] } }))).toMatch(/^All 3 stills were reused /);
    expect(fd.reuseNote(out({ keyframe_reuse: { stills: 1, reused: ["a"] } }))).toMatch(/^The still was reused /);
  });

  it("is empty for a render that drew every still, beside a witness that is not", () => {
    expect(fd.reuseNote(out({}))).toBe("");
    expect(fd.reuseNote(out({ keyframe_reuse: { stills: 3, reused: [] } }))).toBe("");
    expect(fd.reuseNote(null)).toBe("");
    expect(fd.reuseNote(out({ keyframe_reuse: { stills: 3, reused: ["shot_02"] } }))).not.toBe("");
  });
});

describe("cf#1385 keyframeReused: the per-still tag", () => {
  it("marks a still from its own entry or the render-level list, and only on a literal true", () => {
    const o = out({ keyframe_reuse: { stills: 3, reused: ["shot_02"] } });
    expect(fd.keyframeReused(o, { shot_id: "shot_01", reused: true })).toBe(true);
    expect(fd.keyframeReused(o, { shot_id: "shot_02" })).toBe(true);
    expect(fd.keyframeReused(o, { shot_id: "shot_03" })).toBe(false);
    expect(fd.keyframeReused(o, { shot_id: "shot_03", reused: "true" })).toBe(false);
    expect(fd.keyframeReused(out({}), { shot_id: "shot_02" })).toBe(false);
    expect(fd.keyframeReusedShots(o)).toEqual(["shot_02"]);
  });
});

describe("cf#1385 the history row wires the tag, the line and the regen wording", () => {
  const js = readFileSync(join(ROOT, "public/planner-history-row.js"), "utf8");
  it("appends the per-still tag and the row line from the shared helpers", () => {
    expect(js).toContain("window.finishDegrade.keyframeReused(r.output, kf)");
    expect(js).toContain("window.finishDegrade.reuseNote(r.output)");
    expect(js).toContain("reuse.className = \"planner-history-reuse-note\"");
  });
  it("the regen confirm says it keeps the seed and how to get a different picture", () => {
    expect(js).toContain("regen keeps this render's settings, including its seed.");
    expect(js).toContain("to get a different picture, set a new keyframe seed");
  });
  it("a collapsed row hides the reuse line like its other detail lines", () => {
    const css = readFileSync(join(ROOT, "public/styles.css"), "utf8");
    expect(css).toContain(".planner-history-item-collapsed .planner-history-reuse-note,");
  });
});

describe("cf#1385 the local-gpu door forwards the backend mark", () => {
  it("keeps reused only as a literal true, beside a witness that is forwarded", () => {
    const shots = parseLocalGpuKeyframes({
      output: {
        keyframes: [
          { shot_id: "shot_01", key: "k/1.png", reused: true },
          { shot_id: "shot_02", key: "k/2.png", reused: "true" },
          { shot_id: "shot_03", key: "k/3.png" },
        ],
      },
    });
    expect(shots).toEqual([
      { shot_id: "shot_01", keyframe_key: "k/1.png", reused: true },
      { shot_id: "shot_02", keyframe_key: "k/2.png" },
      { shot_id: "shot_03", keyframe_key: "k/3.png" },
    ]);
  });
});
