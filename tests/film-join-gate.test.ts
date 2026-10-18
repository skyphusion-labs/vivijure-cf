import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FilmJob } from "@skyphusion-labs/vivijure-core/film-orchestrator";
import {
  LINE_WINDOW_MAX_SECONDS,
  LINE_WORDS_PER_SECOND,
  beatsMarkerKey,
  jobAfterSkippedJoin,
  lineWindowRefusal,
  lineWordCount,
  songStartRefusal,
} from "../src/film-join-gate";

function job(over: Partial<FilmJob>): FilmJob {
  return {
    film_id: "film-join",
    project: "p",
    scenes: [],
    phase: "done",
    created_at: 0,
    ...over,
  } as FilmJob;
}

describe("film join gate", () => {
  it("names the beat marker beside the song key", () => {
    expect(beatsMarkerKey("audio/bed.mp3")).toBe("audio/bed.mp3.beats.json");
    expect(beatsMarkerKey("  audio/bed.mp3  ")).toBe("audio/bed.mp3.beats.json");
  });

  it("a 30 word line fits a 12s window and 31 words do not", () => {
    const fit = "word ".repeat(30).trim();
    const over = "word ".repeat(31).trim();
    expect(lineWordCount(fit)).toBe(30);
    expect(lineWordCount(fit) / LINE_WORDS_PER_SECOND).toBe(LINE_WINDOW_MAX_SECONDS);
    expect(lineWindowRefusal([{ shot_id: "shot_01", text: fit }])).toBeNull();
    const refusal = lineWindowRefusal([{ shot_id: "shot_01", text: over }]);
    expect(refusal).toMatch(/shot_01/);
    expect(refusal).toMatch(/estimate/);
    expect(refusal).toMatch(/31 words/);
  });

  it("a film with no song is not refused for line length", () => {
    expect(lineWindowRefusal(undefined)).toBeNull();
    expect(lineWindowRefusal([])).toBeNull();
  });

  it("a song with no marker is refused, and a read song is not", async () => {
    const missing = await songStartRefusal(async () => null, "audio/bed.mp3", []);
    expect(missing).toMatch(/beats were not read/);
    const read = await songStartRefusal(async () => ({ size: 1 }), " audio/bed.mp3 ", []);
    expect(read).toBeNull();
    const blank = await songStartRefusal(async () => {
      throw new Error("head must not run");
    }, "  ", []);
    expect(blank).toBeNull();
  });

  it("a missed join on a done job is reported as a failed film", () => {
    const reason = "video-finish tier unreachable; delivered per-shot clips";
    const failed = jobAfterSkippedJoin(job({
      finish_unavailable: { at: "assemble", reason, delivered: "clips", clips: [{ shot_id: "shot_01", clip_key: "c.mp4" }] },
    }));
    expect(failed.phase).toBe("failed");
    expect(failed.error).toBe(reason);
  });

  it("a finished film and a mux miss stay as the job recorded them", () => {
    const done = job({ film_key: "film.mp4" });
    expect(jobAfterSkippedJoin(done)).toBe(done);
    const mux = job({
      finish_unavailable: { at: "mux", reason: "mux missed", delivered: "silent_film" },
    });
    expect(jobAfterSkippedJoin(mux).phase).toBe("done");
  });

  it("both poll doors and the film start doors call the gate", () => {
    const index = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
    const polls = index.match(/jobAfterSkippedJoin\(r\.job\)/g) ?? [];
    expect(polls).toHaveLength(2);
    const starts = index.match(/songStartRefusal\(/g) ?? [];
    expect(starts.length).toBeGreaterThanOrEqual(3);
    expect(index).toContain("beatsMarkerKey(");
    const finalize = readFileSync(join(import.meta.dirname, "..", "src", "finalize-from-keyframes.ts"), "utf8");
    expect(finalize).toContain("songStartRefusal(");
    const planner = readFileSync(join(import.meta.dirname, "..", "public", "planner-audio.js"), "utf8");
    expect(planner).toContain("LINE_WORDS_PER_SECOND = 2.5");
    expect(planner).toContain("LINE_WINDOW_MAX_SECONDS = 12");
    expect(planner).toContain("applySpokenOrBeatSeconds");
    const hint = readFileSync(join(import.meta.dirname, "..", "public", "planner.html"), "utf8");
    expect(hint).toContain("A full song is mp3 or m4a");
    expect(hint).toContain("32 MB");
  });
});
