import { describe, it, expect } from "vitest";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "@skyphusion-labs/vivijure-core/film-orchestrator";
import type { Env } from "../src/env";
import { orch } from "./orchestrator-env";
import { vfAsyncDoor } from "./install-vf-fetch.js";

// F2: audio-master (or any long/ballooned bed) can push the mux bed over the video-finish container audio
// cap, so the container "finishes silent" -- it returns ok:true but writes a track-less MP4 and reports
// hasAudio:false. The mux MUST NOT mark that a silent green (phase=done with the bed silently dropped and
// no signal in the poll). It must surface an OBSERVABLE mux degrade (finish_unavailable at mux) and ship
// the silent film honestly (#245 / #249 / #77). hasAudio:undefined (an older container that omits the
// field) is unknown, not false, so the prior success behavior must hold.

function muxEnv(job: object, containerBody: unknown, opts: { containerWrote?: string[] } = {}) {
  const filmId = (job as { film_id: string }).film_id;
  /** Keys the CONTAINER wrote directly to R2 via presigned PUT. Defaults to the mux output, which
   *  is what a successful mux produces; pass [] to model the container reporting success without
   *  the artifact landing, which is the state cf#833's gate exists to catch. */
  const j = job as { mux_output_key?: string; silent_film_key?: string };
  const writtenByContainer = new Set(
    (opts.containerWrote ?? [j.mux_output_key, j.silent_film_key].filter(Boolean)) as string[],
  );
  let stored = JSON.stringify(job);
  const jsonResp = (b: unknown) =>
    new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      get: async (key: string) => (key === filmJobDocKey(filmId) ? { text: async () => stored } : null),
      // cf#833 / core 1.25.0: the film is only `done` if the film is actually THERE, and core now
      // heads R2 to check. This stub used to answer null for every key, which modelled an R2 where
      // the mux output never landed -- and the old assertions read `done` only because nothing
      // looked. The container PUTs the film straight to R2 through a presigned URL, so the Worker
      // never sees that write and a Worker-side mock cannot observe it via `put`; modelling it here
      // is what makes the fixture match the real flow rather than a world with no artifacts in it.
      // Anything the flow did NOT write still answers null, so the gate can still fail.
      // The size sits above the 2048-byte deliverability floor deliberately: cf#833 refuses a
      // TRUNCATED film as well as an absent one, so a 1-byte stub would trip that arm while
      // looking like a presence failure. Two different refusals need two different fixtures.
      head: async (key: string) =>
        (writtenByContainer.has(key) ? ({ size: 4_194_304 } as unknown) : null),
      put: async (key: string, val: string) => { if (key === filmJobDocKey(filmId)) stored = val; },
    },
    VIDEO_FINISH_URL: "https://video-finish.test", MEDIA_DOOR_FETCH: vfAsyncDoor(containerBody),
    R2_S3_ACCESS_KEY_ID: "test", R2_S3_SECRET_ACCESS_KEY: "test",
    R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
  };
  return { env: orch(env as unknown as Env), read: () => JSON.parse(stored) as FilmJob };
}

const SILENT = "renders/film-mux-honesty/film-silent.mp4";
const OUT = "renders/film-mux-honesty/film-audio.mp4";
const muxJob = (over: object = {}) => ({
  film_id: "film-mux-honesty",
  project: "p",
  scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
  phase: "mux" as const,
  silent_film_key: SILENT,
  audio_key: "renders/film-mux-honesty/bed_mastered.wav",
  mux_output_key: OUT,
  created_at: 0,
  ...over,
});

describe("mux honesty: a dropped bed is an OBSERVABLE degrade, never a silent green (F2)", () => {
  it("hasAudio:false -> finish_unavailable at mux, ships the silent film, phase done", async () => {
    const { env, read } = muxEnv(muxJob(), { ok: true, key: OUT, hasAudio: false });
    const r = await advanceFilmJob(env, "film-mux-honesty");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.finish_unavailable?.at).toBe("mux");
    expect(r?.job.finish_unavailable?.delivered).toBe("silent_film");
    expect(r?.job.finish_unavailable?.reason).toMatch(/could not attach the audio bed/i);
    // the honest silent film (the assembled silent key), NOT the track-less muxed key dressed up as done
    expect(r?.job.film_key).toBe(SILENT);
    expect(read().finish_unavailable?.at).toBe("mux"); // persisted
  });

  it("hasAudio:true -> normal green with the muxed film, no degrade", async () => {
    const { env } = muxEnv(muxJob(), { ok: true, key: OUT, hasAudio: true });
    const r = await advanceFilmJob(env, "film-mux-honesty");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.finish_unavailable).toBeUndefined();
    expect(r?.job.film_key).toBe(OUT);
  });

  it("hasAudio absent (older container build) -> back-compat: normal green, no false degrade", async () => {
    const { env } = muxEnv(muxJob(), { ok: true, key: OUT });
    const r = await advanceFilmJob(env, "film-mux-honesty");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.finish_unavailable).toBeUndefined();
    expect(r?.job.film_key).toBe(OUT);
  });
});
