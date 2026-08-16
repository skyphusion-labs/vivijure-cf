import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  FLAGGED_MSG,
  KEYFRAMES_MSG,
  UNKNOWN_MSG,
  classifyError,
  firstHumanLine,
  recipeFromError,
} from "../public/planner-error-recipe.js";

// cf#649. A failed render used to paste 7003 / 3030 JSON as the first line.
// The panel must map those classes to one sentence before the raw payload.

describe("classifyError", () => {
  it("maps 7003 and keyframe-shape rejects to keyframes", () => {
    expect(classifyError("7003")).toBe("keyframes");
    expect(classifyError('{"code":"7003","error":"bad input"}')).toBe("keyframes");
    expect(classifyError("Unsupported field: keyframes")).toBe("keyframes");
    expect(classifyError("Invalid value at keyframes[0]")).toBe("keyframes");
  });

  it("maps 3030 / flagged / PrivacyInformation / real person to flagged", () => {
    expect(classifyError("3030")).toBe("flagged");
    expect(classifyError("Your output has been flagged")).toBe("flagged");
    expect(classifyError("PrivacyInformation: blocked")).toBe("flagged");
    expect(classifyError("looks like a real person")).toBe("flagged");
  });

  it("CONTROL: an unrelated failure is unknown, not a false recipe", () => {
    expect(classifyError("pod timed out")).toBe("unknown");
    expect(classifyError("")).toBe("unknown");
    expect(classifyError(null)).toBe("unknown");
  });
});

describe("recipeFromError", () => {
  it("7003 is a next step, not the JSON", () => {
    const rec = recipeFromError('{"code":"7003","error":"Unsupported field"}');
    expect(rec.kind).toBe("keyframes");
    expect(rec.message).toBe(KEYFRAMES_MSG);
    expect(rec.raw).toContain("7003");
    expect(rec.message).not.toContain("{");
  });

  it("3030 is a next step, not the JSON", () => {
    const rec = recipeFromError('{"code":"3030","error":"flagged"}');
    expect(rec.kind).toBe("flagged");
    expect(rec.message).toBe(FLAGGED_MSG);
    expect(rec.raw).toContain("3030");
  });

  it("unknown JSON still leads with a human line, raw kept for the fold", () => {
    const rec = recipeFromError('{"error":"volume full","code":"x"}');
    expect(rec.kind).toBe("unknown");
    expect(rec.message).toBe("volume full");
    expect(rec.raw).toContain("volume full");
  });

  it("empty input is an honest unknown, not a blank line", () => {
    const rec = recipeFromError("");
    expect(rec.kind).toBe("unknown");
    expect(rec.message).toBe(UNKNOWN_MSG);
  });
});

describe("firstHumanLine", () => {
  it("reads error from a JSON object and ignores a blob of keys", () => {
    expect(firstHumanLine('{"code":"x","error":"disk full"}')).toBe("disk full");
  });

  it("falls back to the first prose line", () => {
    expect(firstHumanLine("disk full\nmore")).toBe("disk full");
  });
});

describe("first-sitting UX pins (cf#644 #645 #649)", () => {
  const html = readFileSync("public/planner.html", "utf8");
  const css = readFileSync("public/styles.css", "utf8");
  const bundle = readFileSync("public/planner-bundle.js", "utf8");
  const stepper = readFileSync("public/planner-stepper.js", "utf8");

  it("lede is filmmaker language, not a training-bundle console", () => {
    expect(html).not.toMatch(/assemble the training bundle/);
    expect(html).toMatch(/Write the storyboard/);
  });

  it("bundle success goes to render, not Audio", () => {
    expect(bundle).not.toMatch(/showStep\(["']audio["']\)/);
    expect(bundle).toMatch(/showStep\(["']render["']\)/);
  });

  it("the rail labels History as Your films and does not force Audio as step 3", () => {
    expect(stepper).toMatch(/label:\s*"Your films"/);
    expect(stepper).not.toMatch(/label:\s*"Audio"/);
  });

  it("studio nav stays reachable below 860px", () => {
    const block = css.split("@media (max-width: 860px)")[1] || "";
    const rule = block.slice(0, 400);
    expect(rule, "860px media query is gone; re-anchor this pin").toContain(".studio-nav");
    expect(rule).not.toMatch(/\.studio-nav\s*\{\s*display:\s*none/);
  });
});
