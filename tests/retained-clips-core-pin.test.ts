import { describe, expect, it } from "vitest";
import { downloadableClips } from "../src/film-join-gate";
import { deliveredSummary, degradeFrom } from "../public/finish-degrade.js";

// Core 1.26.0 fails a film whose join did not run and names the clips as retained. The panel and the
// poll read only `done` and `delivered`, so without this the paid clips had no download link.

const clips = [{ shot_id: "shot_01", clip_key: "renders/p/clips/shot_01.mp4" }];
const retained = { at: "assemble" as const, reason: "no slot", retained: "clips" as const, clips };

describe("downloadableClips", () => {
  it("offers retained clips on a failed film", () => {
    expect(downloadableClips({ phase: "failed", finish_unavailable: retained })).toEqual(clips);
  });

  it("still offers clips from an older job doc that says done", () => {
    const old = { at: "assemble" as const, reason: "r", delivered: "clips" as const, clips };
    expect(downloadableClips({ phase: "done", finish_unavailable: old })).toEqual(clips);
  });

  it("offers nothing while a film is running", () => {
    expect(downloadableClips({ phase: "assemble", finish_unavailable: retained })).toEqual([]);
  });

  it("offers nothing for a mux miss, which has no clips", () => {
    expect(downloadableClips({ phase: "failed", finish_unavailable: { at: "mux", reason: "r", retained: "silent_film" } })).toEqual([]);
  });

  it("offers nothing on a normal film", () => {
    expect(downloadableClips({ phase: "done" })).toEqual([]);
  });
});

describe("deliveredSummary on a failed film", () => {
  it("says the clips are kept, and does not say they were delivered", () => {
    const s = deliveredSummary(degradeFrom({
      finish_unavailable: { at: "assemble", reason: "r", retained: "clips" },
      clips: [{ shot_id: "shot_01", key: "k" }],
    })) as string;
    expect(s).toContain("no film was made");
    expect(s).toContain("1 per-shot clip is kept");
    expect(s).not.toContain("delivered");
  });

  it("says the silent cut is kept", () => {
    const s = deliveredSummary(degradeFrom({ finish_unavailable: { at: "mux", reason: "r", retained: "silent_film" } })) as string;
    expect(s).toContain("The silent cut is kept");
    expect(s).not.toContain("delivered the SILENT film");
  });
});
