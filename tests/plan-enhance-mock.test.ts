import { describe, expect, it } from "vitest";
import { plannerAiMockEnabled, mockPlannerRaw } from "../modules/plan-enhance/src/mock";

// Repointed from tests/planner-ai-mock.test.ts (cf#129). src/planner-ai-mock.ts was deleted as an
// orphan -- cf#62 moved every model call into the plan-enhance module, taking the mock with it, and
// the studio-side copy lost its last call site. The BEHAVIOUR is still live in the module, so this
// coverage follows the code rather than dying with the shim. Note the shape difference that made a
// straight file-move wrong: the module copy returns a bare string; the deleted studio copy returned
// { response } because it fed the Workers AI extractOutput normalizer that no longer sits in path.
describe("plannerAiMockEnabled", () => {
  it("is off unless explicitly switched on", () => {
    expect(plannerAiMockEnabled({})).toBe(false);
    expect(plannerAiMockEnabled({ PLANNER_AI_MOCK: "" })).toBe(false);
    expect(plannerAiMockEnabled({ PLANNER_AI_MOCK: "0" })).toBe(false);
  });

  it("is on for the documented truthy values", () => {
    expect(plannerAiMockEnabled({ PLANNER_AI_MOCK: "1" })).toBe(true);
    expect(plannerAiMockEnabled({ PLANNER_AI_MOCK: "true" })).toBe(true);
  });
});

describe("mockPlannerRaw branches", () => {
  it("returns a bare string, not the old { response } envelope", () => {
    expect(typeof mockPlannerRaw("anything")).toBe("string");
  });

  it("default branch is valid storyboard JSON", () => {
    const parsed = JSON.parse(mockPlannerRaw("a quiet harbor"));
    expect(Array.isArray(parsed.scenes)).toBe(true);
    expect(parsed.scenes.length).toBeGreaterThan(0);
  });

  it("#mock-badjson drives the non-JSON branch", () => {
    const raw = mockPlannerRaw("please fail #mock-badjson");
    expect(() => JSON.parse(raw)).toThrow();
  });

  // Sentinel is "#mock-fail" (NOT "#mock-reject" -- I guessed that name first and this test caught
  // it, which is the point: an unknown sentinel silently falls through to the PASS branch, so a
  // wrong token here would have quietly asserted nothing).
  it("#mock-fail returns parseable JSON that the validator rejects", () => {
    const parsed = JSON.parse(mockPlannerRaw("please #mock-fail"));
    // Scene 2 deliberately omits the required prompt: parses fine, fails validation.
    expect(parsed.scenes.some((s: Record<string, unknown>) => !s.prompt)).toBe(true);
  });

  // The negative control for the test above: an UNKNOWN sentinel must fall through to the valid
  // pass branch. Without this, a future rename of "#mock-fail" turns the reject test into a test
  // that asserts nothing while still going green.
  it("an unknown sentinel falls through to the valid pass branch", () => {
    const parsed = JSON.parse(mockPlannerRaw("please #mock-notarealsentinel"));
    expect(parsed.scenes.every((s: Record<string, unknown>) => !!s.prompt)).toBe(true);
  });
});
