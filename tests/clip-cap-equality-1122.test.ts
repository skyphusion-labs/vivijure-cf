import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASSEMBLE_MAX_CLIPS,
  assembleFilmByteCeiling,
  CONTAINER_BATCH_PEAK_BYTES,
  CONTAINER_DISK_BYTES,
  CONTAINER_IMAGE_RESERVE_BYTES,
  FINALIZE_FILM_COPIES,
} from "@skyphusion-labs/vivijure-core/assemble-admission";
import { ASSEMBLE_MAX_POOL_PAIRS } from "@skyphusion-labs/vivijure-core/video-finish-assemble";
import { STORYBOARD_MAX_SCENES } from "@skyphusion-labs/vivijure-core/storyboard-validate";

// vivijure-cf#1122. Each cap below is held in two places.
// core's ASSEMBLE_MAX_CLIPS refuses a film at submit; the container's MAX_CLIPS refuses it at assemble.
// If core's is higher, a film passes submit, buys every clip, and then the container refuses it. So the
// property is core <= container, not equality: the container is raised and deployed FIRST, and core
// follows. The bed is the same shape: what matters is that the disk left with the container's real
// bed limit still covers the largest film core admits, whatever core reserves.
// The panel's PLANNER_MAX_SCENES must equal core's STORYBOARD_MAX_SCENES, or the panel either offers
// boards the validator refuses or refuses boards it would take.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const intConst = (source: string, re: RegExp): number => {
  const m = re.exec(source);
  expect(m, `pattern ${re} not found`).not.toBeNull();
  return Number(m![1].replaceAll("_", ""));
};

describe("caps held equal across core and this repo (vivijure-cf#1122)", () => {
  it("core never admits more clips than the video-finish container takes", () => {
    const containerCap = intConst(read("containers/video-finish/app.py"), /^MAX_CLIPS = ([\d_]+)$/m);
    expect(ASSEMBLE_MAX_CLIPS).toBeLessThanOrEqual(containerCap);
  });

  it("an assemble body at the container clip cap fits the container's request limit", () => {
    const app = read("containers/video-finish/app.py");
    const clips = intConst(app, /^MAX_CLIPS = ([\d_]+)$/m);
    const m = /client_max_size=(?:(\d+) \* )?1024 \* 1024,/.exec(app);
    expect(m, "client_max_size pattern").not.toBeNull();
    const limit = Number(m![1] ?? 1) * 1024 * 1024;
    // The shape core sends (film-orchestrator.ts: clips are { url }, plus the pool and the output). A presigned
    // R2 URL measured at 445 bytes in the vivijure-cf#1122 plan; padded to 600 here for headroom.
    const url = "https://r2.example/" + "x".repeat(600 - 19);
    const body = JSON.stringify({
      clips: Array.from({ length: clips }, () => ({ url })),
      partialUrls: Array.from({ length: ASSEMBLE_MAX_POOL_PAIRS }, () => ({ put: url, get: url })),
      outputUrl: url, outputKey: "renders/p/film.mp4", width: 1920, height: 1080, fps: 24, keepClipAudio: true,
    });
    expect(new TextEncoder().encode(body).length).toBeLessThan(limit);
  });

  it("with the container's real bed limit on disk, finalize still fits the largest film core admits", () => {
    const app = read("containers/video-finish/app.py");
    const m = /^MAX_AUDIO_BYTES = (\d+) \* 1024 \* 1024$/m.exec(app);
    expect(m, "MAX_AUDIO_BYTES pattern").not.toBeNull();
    const bed = Number(m![1]) * 1024 * 1024;
    const disk = Math.floor((CONTAINER_DISK_BYTES - CONTAINER_BATCH_PEAK_BYTES - bed - CONTAINER_IMAGE_RESERVE_BYTES) / FINALIZE_FILM_COPIES);
    expect(disk).toBeGreaterThanOrEqual(assembleFilmByteCeiling());
  });

  it("the panel PLANNER_MAX_SCENES equals core STORYBOARD_MAX_SCENES", () => {
    const panelCap = intConst(read("public/planner-audio.js"), /^const PLANNER_MAX_SCENES = (\d+);/m);
    expect(panelCap).toBe(STORYBOARD_MAX_SCENES);
  });
});
