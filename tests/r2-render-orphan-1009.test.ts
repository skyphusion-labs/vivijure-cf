import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  buildRenderOwnerIndex,
  classifyRenderKey,
  jobKindOf,
  PROJECT_NAME_SQL,
  reconcileRenders,
  refuseOversizedSweep,
  RENDER_OWNER_SQL,
  SHOT_OWNER_SQL,
  type RenderObjectLite,
} from "../src/r2-render-orphan-reconcile";
import type { RenderKeyRow, ShotKeyRow } from "../src/record-reclaim";

// cf#1009, the provable part (lead ruling 2026-11-06). D1 is REAL SQLite with the repo migrations, read
// with the SAME SQL the operator snapshot runs; R2 is an in-memory bucket the job docs are read from.
// Each case states the owner, or the reason no owner can be proven, and the verdict.

const ROOT = join(__dirname, "..");
const u = (n: number) => `0000000${n}`.slice(-8) + "-0000-4000-8000-000000000000";
const FILM_A = "film-" + u(1);     // live row
const SCAT_S = "scatter-" + u(2);  // live row, names shard FILM_B
const FILM_B = "film-" + u(3);     // shard, NO row yet
const FILM_C = "film-" + u(4);     // live row, names clip job CLIPS_C
const CLIPS_C = "clips-" + u(5);
const FILM_D = "film-" + u(6);     // shot_records only
const FILM_X = "film-" + u(7);     // dead
const SCAT_Y = "scatter-" + u(8);  // dead
const CLIPS_Z = "clips-" + u(9);   // named by no live film
const FILM_N = "film-" + u(10);    // dead, but a live row names one of its keys
const FILM_P = "film-" + u(11);    // dead, but also a live project name
const FILM_Q = "film-" + u(12);    // dead, but a live film doc names a still in it
const FILM_R = "film-" + u(13);    // dead, but a live render row uses it as its project
const NOW = Date.parse("2026-11-06T12:00:00Z");
const OLD = NOW - 30 * 24 * 3600 * 1000;

function realDb() {
  const db = new DatabaseSync(":memory:");
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const render = (job: string, project: string, extra: { output_key?: string } = {}) =>
    db.prepare("INSERT INTO renders (job_id, project, status, submitted_at, output_key) VALUES (?, ?, ?, ?, ?)").run(job, project, "COMPLETED", 1, extra.output_key ?? null);
  render(FILM_A, "p");
  render(SCAT_S, "p");
  render(FILM_C, "p", { output_key: `renders/${FILM_N}/film.mp4` });
  render("film-" + u(14), FILM_R);
  db.prepare("INSERT INTO shot_records (film_id, shot_id, still_key, step, updated_at) VALUES (?, ?, ?, ?, ?)").run(FILM_D, "shot_01", null, "still", 1);
  db.prepare("INSERT INTO storyboard_projects (slug, name) VALUES (?, ?)").run("odd", FILM_P);
  return db;
}

function snapshot(db: DatabaseSync) {
  return {
    renderRows: db.prepare(RENDER_OWNER_SQL).all() as unknown as RenderKeyRow[],
    shotRows: db.prepare(SHOT_OWNER_SQL).all() as unknown as ShotKeyRow[],
    projectNames: (db.prepare(PROJECT_NAME_SQL).all() as Array<{ name: string }>).map((r) => r.name),
  };
}

function bucket(docs: Record<string, unknown>, corrupt: string[] = []) {
  const store = new Map<string, string>(Object.entries(docs).map(([k, v]) => [k, JSON.stringify(v)]));
  for (const k of corrupt) store.set(k, "{not json");
  return {
    store,
    readDoc: async (key: string) => {
      const v = store.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
  };
}

const DOCS = {
  [`renders/${SCAT_S}/scatter-job.json`]: { scatter_id: SCAT_S, shard_film_ids: [FILM_B] },
  [`renders/${FILM_C}/film-job.json`]: { film_id: FILM_C, clip_job_id: CLIPS_C, shots: [{ clip_key: "renders/p/clips/shot_01_x.mp4", still_key: `renders/${FILM_Q}/kf.png` }] },
  [`renders/${CLIPS_C}/clips-job.json`]: { shots: [{ takes: [{ key: `renders/${FILM_X}/kept-take.mp4` }] }] },
};

async function index(docs: Record<string, unknown> = DOCS) {
  const b = bucket(docs);
  return buildRenderOwnerIndex({ ...snapshot(realDb()), readDoc: b.readDoc });
}
const obj = (key: string, mtimeMs: number | null = OLD): RenderObjectLite => ({ key, size: 10, mtimeMs });
const verdict = async (key: string, mtimeMs: number | null = OLD) => classifyRenderKey(obj(key, mtimeMs), await index(), NOW).decision;

describe("cf#1009 jobKindOf", () => {
  it("reads only the three job-id shapes", () => {
    expect(jobKindOf(FILM_A)).toBe("film");
    expect(jobKindOf(SCAT_S)).toBe("scatter");
    expect(jobKindOf(CLIPS_C)).toBe("clips");
    for (const s of ["film-1", "p", "logs", "film-" + u(1) + "x", "Film-" + u(1), "sync-" + u(1)]) expect(jobKindOf(s), s).toBeNull();
  });
});

describe("cf#1009 owners proven from records", () => {
  it("a live render row keeps its tree and its log", async () => {
    expect(await verdict(`renders/${FILM_A}/film.mp4`)).toBe("keep");
    expect(await verdict(`renders/logs/${FILM_A}.txt`)).toBe("keep");
    expect(await verdict(`renders/${SCAT_S}/film.mp4`)).toBe("keep");
  });
  it("a shard a live scatter doc names is kept with no row of its own", async () => {
    expect(await verdict(`renders/${FILM_B}/film-job.json`)).toBe("keep");
  });
  it("a film with only shot_records is kept", async () => {
    expect(await verdict(`renders/${FILM_D}/film-job.json`)).toBe("keep");
  });
  it("a clip job a live film doc names is kept", async () => {
    expect(await verdict(`renders/${CLIPS_C}/clips-job.json`)).toBe("keep");
  });
  it("a key a live row or a live job doc names is kept inside a dead tree", async () => {
    expect(await verdict(`renders/${FILM_N}/film.mp4`)).toBe("keep");
    expect(await verdict(`renders/${FILM_X}/kept-take.mp4`)).toBe("keep");
    expect(await verdict(`renders/${FILM_Q}/kf.png`)).toBe("keep");
    expect(await verdict(`renders/${FILM_Q}/other.png`)).toBe("orphan");
  });
});

describe("cf#1009 orphans", () => {
  it("a film or scatter tree with no owner, and its log, are orphans", async () => {
    expect(await verdict(`renders/${FILM_X}/film.mp4`)).toBe("orphan");
    expect(await verdict(`renders/${FILM_X}/partials/partial-001.mp4`)).toBe("orphan");
    expect(await verdict(`renders/${SCAT_Y}/scatter-job.json`)).toBe("orphan");
    expect(await verdict(`renders/logs/${FILM_X}.txt`)).toBe("orphan");
    expect(await verdict(`renders/${FILM_N}/other.mp4`)).toBe("orphan");
  });
});

describe("cf#1009 out of scope, never deleted", () => {
  it("a clip job no live film names (may be standalone, cf#1309)", async () => {
    expect(await verdict(`renders/${CLIPS_Z}/clips-job.json`)).toBe("out-of-scope");
  });
  it("project-keyed trees, renders/cast/, and a project slugged logs", async () => {
    expect(await verdict("renders/p/clips/shot_02_x.mp4")).toBe("out-of-scope");
    expect(await verdict("renders/gone-project/keyframes/s.png")).toBe("out-of-scope");
    expect(await verdict("renders/cast/clips/voice-sample_cf-seedance.mp4")).toBe("out-of-scope");
    expect(await verdict("renders/logs/clips/shot_01_x.mp4")).toBe("out-of-scope");
    expect(await verdict("renders/logs/not-a-job.txt")).toBe("out-of-scope");
  });
  it("a job-shaped segment that is also a live project name", async () => {
    expect(await verdict(`renders/${FILM_P}/clips/shot_01_x.mp4`)).toBe("out-of-scope");
    expect(await verdict(`renders/${FILM_R}/clips/shot_01_x.mp4`)).toBe("out-of-scope");
  });
  it("anything outside renders/", async () => {
    for (const k of ["bundles/p-abc.tar.gz", "audio/x.mp3", "keyframe-stage/p/j/a.png", "cast-image/j.state.json"]) {
      expect(await verdict(k), k).toBe("out-of-scope");
    }
  });
});

describe("cf#1009 guards that fail toward keep", () => {
  it("a dead tree inside the grace window, or with no mtime, is kept", async () => {
    expect(await verdict(`renders/${FILM_X}/film.mp4`, NOW - 3600 * 1000)).toBe("keep");
    expect(await verdict(`renders/${FILM_X}/film.mp4`, null)).toBe("keep");
    expect(await verdict(`renders/${FILM_X}/film.mp4`, NOW - 49 * 3600 * 1000)).toBe("orphan");
  });
  it("a live doc that cannot be read aborts the index", async () => {
    const b = bucket(DOCS, [`renders/${FILM_A}/film-job.json`]);
    await expect(buildRenderOwnerIndex({ ...snapshot(realDb()), readDoc: b.readDoc })).rejects.toThrow();
  });
  it("an oversized listing is refused before anything is judged", () => {
    expect(refuseOversizedSweep(10, 10)).toBeNull();
    expect(refuseOversizedSweep(11, 10)).toMatch(/Nothing was deleted/);
  });
});

describe("cf#1009 reconcileRenders over a mixed listing", () => {
  it("splits the listing, counts orphan bytes, and orphans nothing out of scope", async () => {
    const listing = [
      obj(`renders/${FILM_A}/film.mp4`), obj(`renders/${FILM_X}/film.mp4`), obj(`renders/logs/${FILM_X}.txt`),
      obj(`renders/${CLIPS_Z}/clips-job.json`), obj("renders/p/clips/a.mp4"), obj("bundles/b.tar.gz"),
    ];
    const r = reconcileRenders(listing, await index(), NOW);
    expect(r.orphans.map((c) => c.key)).toEqual([`renders/${FILM_X}/film.mp4`, `renders/logs/${FILM_X}.txt`]);
    expect(r.orphanBytes).toBe(20);
    expect(r.kept.map((c) => c.key)).toEqual([`renders/${FILM_A}/film.mp4`]);
    expect(r.outOfScope).toHaveLength(3);
  });
});
