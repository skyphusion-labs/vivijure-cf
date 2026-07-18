import { describe, expect, it } from "vitest";
import { findModel } from "../src/models";

describe("findModel", () => {
  it("finds image models used by the cast page", () => {
    expect(findModel("@cf/black-forest-labs/flux-2-klein-9b")?.type).toBe("image");
    expect(findModel("google/nano-banana-pro")?.type).toBe("image");
  });

  it("no longer carries planning model names (cf#62) -- the module declares those", () => {
    // The catalog is projected from the installed plan.enhance module now. findModel() is consulted
    // ONLY to detect image models; an absent text id falls through to the module dispatch path, so
    // this returning undefined is the intended post-cf#62 state, not a regression.
    expect(findModel("anthropic/claude-sonnet-4-6")).toBeUndefined();
    expect(findModel("anthropic/claude-opus-4-8")).toBeUndefined();
  });

  it("still finds a non-planning chat model", () => {
    expect(findModel("@cf/openai/gpt-oss-120b")?.type).toBe("chat");
  });

  it("returns undefined for unknown ids", () => {
    expect(findModel("not-a-real/model")).toBeUndefined();
  });
});
