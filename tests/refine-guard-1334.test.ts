/// <reference types="node" />
// cf#1334: the panel refuses a refine reply that would shorten a board of more than 50 scenes. When the guard
// was written, the refinement prompt capped its reply at core's PLANNER_ASK_MAX_SCENES, so a long board could
// come back cut to 50. Since core 1.39.0 (vivijure-core#473) the prompt says to return every scene unless the
// user asks to remove some, and PLANNER_ASK_MAX_SCENES bounds what one turn adds or rewrites, not the board.
// The guard stays as a backstop, and its threshold is still that constant. cf#1341 holds the decision on
// relaxing it, with a measured refine on a 60-scene board. The browser run (tests/browser/refine-guard-1334.mjs)
// proves the flow; this pins the rule and its threshold.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PLANNER_ASK_MAX_SCENES } from "@skyphusion-labs/vivijure-core/planner-prompt";

const refineJs = readFileSync("public/planner-refine.js", "utf8");
const { refineShrinksLongBoard, REFINE_GUARD_MIN_SCENES } = new Function(
  refineJs + "\nreturn { refineShrinksLongBoard, REFINE_GUARD_MIN_SCENES };",
)() as { refineShrinksLongBoard: (sent: number, back: number) => boolean; REFINE_GUARD_MIN_SCENES: number };

describe("refine shrink guard (cf#1334)", () => {
  it("the threshold is the refinement prompt's own cap", () => {
    expect(REFINE_GUARD_MIN_SCENES).toBe(PLANNER_ASK_MAX_SCENES);
  });

  it("refuses a shorter reply to a board over the cap", () => {
    expect(refineShrinksLongBoard(51, 50)).toBe(true);
    expect(refineShrinksLongBoard(600, 50)).toBe(true);
    expect(refineShrinksLongBoard(600, 599)).toBe(true);
    expect(refineShrinksLongBoard(60, 0)).toBe(true);
  });

  it("applies a reply that keeps or grows a long board", () => {
    expect(refineShrinksLongBoard(600, 600)).toBe(false);
    expect(refineShrinksLongBoard(60, 61)).toBe(false);
  });

  it("applies any reply to a board at or under the cap, as before", () => {
    expect(refineShrinksLongBoard(50, 10)).toBe(false);
    expect(refineShrinksLongBoard(3, 2)).toBe(false);
    expect(refineShrinksLongBoard(0, 0)).toBe(false);
  });

  it("a bad count is read as zero, never as a long board", () => {
    expect(refineShrinksLongBoard(Number.NaN, 0)).toBe(false);
    expect(refineShrinksLongBoard(undefined as never, 0)).toBe(false);
  });
});
