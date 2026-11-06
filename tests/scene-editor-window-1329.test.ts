/// <reference types="node" />
// cf#1329: the scene editor shows one window of scenes at a time. The browser run
// (tests/browser/scene-editor-600.mjs) proves the editor at 600 rows; this file pins the window math and
// holds the window size equal to what the planner writes in one turn.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PLANNER_ASK_MAX_SCENES } from "@skyphusion-labs/vivijure-core/planner-prompt";

const scenesJs = readFileSync("public/planner-scenes.js", "utf8");

function load() {
  const window: Record<string, unknown> = {};
  const fn = new Function("window", "planState", "$", "document", scenesJs + "\nreturn { scenePageBounds, SCENE_PAGE_SIZE };");
  const out = fn(window, { storyboard: null }, () => null, { getElementById: () => null, querySelector: () => null }) as {
    scenePageBounds: (total: number, start: number, size: number) => { start: number; end: number };
    SCENE_PAGE_SIZE: number;
  };
  return { ...out, window };
}

describe("scene editor window (cf#1329)", () => {
  const { scenePageBounds, SCENE_PAGE_SIZE, window } = load();

  it("one window is what the planner writes in one turn", () => {
    expect(SCENE_PAGE_SIZE).toBe(PLANNER_ASK_MAX_SCENES);
    expect((window.plannerSceneEditor as { pageSize: number }).pageSize).toBe(SCENE_PAGE_SIZE);
  });

  it("a board that fits in one window is shown whole", () => {
    expect(scenePageBounds(2, 0, 50)).toEqual({ start: 0, end: 2 });
    expect(scenePageBounds(50, 0, 50)).toEqual({ start: 0, end: 50 });
    expect(scenePageBounds(50, 49, 50)).toEqual({ start: 0, end: 50 });
  });

  it("a start inside a window snaps to that window", () => {
    expect(scenePageBounds(600, 449, 50)).toEqual({ start: 400, end: 450 });
    expect(scenePageBounds(600, 450, 50)).toEqual({ start: 450, end: 500 });
    expect(scenePageBounds(600, 599, 50)).toEqual({ start: 550, end: 600 });
  });

  it("a start past the end is held to the last window, and the last window can be short", () => {
    expect(scenePageBounds(598, 600, 50)).toEqual({ start: 550, end: 598 });
    expect(scenePageBounds(51, 50, 50)).toEqual({ start: 50, end: 51 });
    expect(scenePageBounds(51, 999, 50)).toEqual({ start: 50, end: 51 });
  });

  it("a bad start or an empty board is safe", () => {
    expect(scenePageBounds(600, -50, 50)).toEqual({ start: 0, end: 50 });
    expect(scenePageBounds(600, Number.NaN, 50)).toEqual({ start: 0, end: 50 });
    expect(scenePageBounds(0, 10, 50)).toEqual({ start: 0, end: 0 });
  });
});
