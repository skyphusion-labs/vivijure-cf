import { describe, it, expect } from "vitest";
import { filmRowFromJob } from "../src/film-render-bridge";
import type { FilmJob } from "@skyphusion-labs/vivijure-core/film-orchestrator";

// cf#393: host mapping of film job -> NewRenderRow must carry the resolved backends so
// insertRender writes them. Core owns the column + INSERT SQL; this asserts the host seed
// does not drop the values on the floor (the defect was "known at submit, never stored").

function filmJob(over: Partial<FilmJob> = {}): FilmJob {
  return {
    film_id: "film-393",
    project: "p",
    bundle_key: "bundles/p.tar.gz",
    scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
    motion_backend: "seedance",
    motion_config: {},
    finish_config: {},
    speech_config: {},
    film_finish_config: {},
    master_config: {},
    keyframe_binding: "MODULE_KEYFRAME",
    phase: "keyframe",
    created_at: Date.now(),
    phase_started_at: Date.now(),
    quality_tier: "standard",
    ...over,
  } as FilmJob;
}

describe("cf#393 filmRowFromJob carries resolved backends", () => {
  it("maps motion_backend from the film job", () => {
    const row = filmRowFromJob(filmJob({ motion_backend: "own-gpu" }));
    expect((row as { motionBackend?: string | null }).motionBackend).toBe("own-gpu");
  });

  it("maps keyframe_backend when present on the job", () => {
    const row = filmRowFromJob(
      filmJob({
        motion_backend: "seedance",
        ...({ keyframe_backend: "keyframe" } as object),
      } as FilmJob),
    );
    expect((row as { keyframeBackend?: string | null }).keyframeBackend).toBe("keyframe");
  });

  it("null motion on keyframes-only stays null", () => {
    const row = filmRowFromJob(
      filmJob({ motion_backend: null, keyframes_only: true, phase: "done" }),
    );
    expect((row as { motionBackend?: string | null }).motionBackend).toBeNull();
  });
});
