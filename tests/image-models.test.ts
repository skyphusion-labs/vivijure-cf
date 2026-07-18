import { describe, expect, it } from "vitest";
import { IMAGE_MODELS, findImageModel } from "../src/image-models";
import type { ModelEntry } from "../src/models";

// Replaces tests/models-find.test.ts (cf#129). findModel() became findImageModel() when the catalog
// was narrowed to the only rows it could ever return -- the image rows. The old name promised a
// lookup over chat / video / tts / stt / music too, none of which had a route or a dispatch path.
describe("findImageModel", () => {
  it("finds the image models the cast page and chat image path dispatch", () => {
    expect(findImageModel("@cf/black-forest-labs/flux-2-klein-9b")?.type).toBe("image");
    expect(findImageModel("google/nano-banana-pro")?.type).toBe("image");
  });

  it("returns undefined for unknown ids", () => {
    expect(findImageModel("not-a-real/model")).toBeUndefined();
  });

  // The bare-skeleton doctrine: the studio hardcodes no planning model names. These resolve through
  // the installed plan.enhance module, never through this catalog.
  it("carries no planning model names (cf#62)", () => {
    expect(findImageModel("anthropic/claude-sonnet-4-6")).toBeUndefined();
    expect(findImageModel("anthropic/claude-opus-4-8")).toBeUndefined();
  });

  // cf#129 deleted 55 rows across chat / video / tts / stt / music / voice. Asserting the catalog is
  // image-ONLY is what keeps a stray row from being re-added to a catalog nothing can dispatch: the
  // failure mode this guards is a picker offering a model the host cannot run.
  it("is image-only -- no row of any other type survives", () => {
    const offenders = IMAGE_MODELS.filter((m: ModelEntry) => m.type !== "image");
    expect(offenders.map((m) => `${m.id}:${m.type}`)).toEqual([]);
  });

  // The wire shape is SHARED with vivijure-local and with the projected planning rows. A field added
  // or renamed on one side and not the other is exactly the drift the shared panel cannot absorb, so
  // it breaks here rather than silently in a picker at runtime.
  it("emits exactly the shared row-shape keys", () => {
    for (const row of IMAGE_MODELS) {
      const keys = Object.keys(row).sort();
      const allowed = ["capabilities", "group", "id", "label", "provider", "type"];
      expect(keys.filter((k) => !allowed.includes(k))).toEqual([]);
      expect(keys).toEqual(expect.arrayContaining(["id", "label", "group", "type", "capabilities"]));
    }
  });

  it("has no duplicate ids", () => {
    const ids = IMAGE_MODELS.map((m) => m.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
