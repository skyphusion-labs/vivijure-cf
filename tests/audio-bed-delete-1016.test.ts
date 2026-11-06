import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import worker from "../src/index";
import { uploadedBedKey, IN_USE_SCAN_LIMIT } from "../src/audio-bed-delete";
import * as audioBed from "../public/audio-bed.js";

// cf#1016: an uploaded audio bed can be deleted. D1 is REAL SQLite with the repo migrations, so the
// in-use query is the shipped SQL; R2 is an in-memory bucket. The cases: the round trip (upload, then
// delete, then a second delete is a 404), the scope (no name but an uploaded bed's), and the 409 while
// a film that has not finished selects the bed, with a finished film NOT holding it.

const ROOT = join(__dirname, "..");

function realD1() {
  const db = new DatabaseSync(":memory:");
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => { const r = db.prepare(sql).run(...(args as never[])); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return { db, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: Array<{ run(): Promise<unknown> }>) => { const out = []; for (const s of ss) out.push(await s.run()); return out; } } };
}

function r2() {
  const store = new Map<string, string>();
  const deleted: string[] = [];
  return {
    store,
    deleted,
    async get(key: string) { const v = store.get(key); return v === undefined ? null : { key, text: async () => v, json: async () => JSON.parse(v) }; },
    async head(key: string) { return store.has(key) ? { key, size: (store.get(key) as string).length } : null; },
    async put(key: string, body: unknown) { store.set(key, typeof body === "string" ? body : "bytes"); return { key }; },
    async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) { store.delete(k); deleted.push(k); } },
    async list() { return { objects: [], truncated: false }; },
  };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function studio() {
  const { db, d1 } = realD1();
  const bucket = r2();
  const env = { ALLOW_UNAUTHENTICATED: "true", DB: d1, R2_RENDERS: bucket, ASSETS: { fetch: async () => new Response("A") } };
  const call = (method: string, path: string, body?: BodyInit, type?: string) =>
    worker.fetch(new Request("https://studio.example" + path, { method, body, headers: type ? { "content-type": type } : {} }), env as never, ctx);
  return { db, bucket, call };
}

async function upload(call: ReturnType<typeof studio>["call"]): Promise<string> {
  const res = await call("POST", "/api/storyboard/audio-upload", new Uint8Array([1, 2, 3]), "audio/mpeg");
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}
const nameOf = (key: string) => key.slice("audio/".length);

describe("cf#1016 DELETE /api/storyboard/audio-upload/:name", () => {
  it("deletes the uploaded bed, and a second delete is a 404 rather than a fake success", async () => {
    const { bucket, call } = studio();
    const key = await upload(call);
    expect(bucket.store.has(key)).toBe(true);
    const res = await call("DELETE", "/api/storyboard/audio-upload/" + nameOf(key));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, key, deleted: true });
    expect(bucket.store.has(key)).toBe(false);
    const again = await call("DELETE", "/api/storyboard/audio-upload/" + nameOf(key));
    expect(again.status).toBe(404);
  });

  it("refuses any name the upload route would not mint, and deletes nothing", async () => {
    const { bucket, call } = studio();
    await bucket.put("renders/film-1/film.mp4", "film");
    await bucket.put("audio/score-bed.mp3", "generated");
    for (const bad of ["score-bed.mp3", "..%2Frenders%2Ffilm-1%2Ffilm.mp4", "0b8f6c4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.exe", "not-a-uuid.mp3"]) {
      const res = await call("DELETE", "/api/storyboard/audio-upload/" + bad);
      expect(res.status, bad).toBe(400);
    }
    expect(bucket.deleted).toEqual([]);
    expect(uploadedBedKey("0B8F6C4E-1D2A-4C3B-9E8F-7A6B5C4D3E2F.MP3")).toBe("audio/0b8f6c4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.mp3");
  });

  it("is a 409 naming the render while an unfinished film selects the bed, and keeps the file", async () => {
    const { db, bucket, call } = studio();
    const key = await upload(call);
    db.prepare(`INSERT INTO renders (job_id, project, status, submitted_at) VALUES ('film-live', 'p', 'IN_PROGRESS', 1)`).run();
    await bucket.put("renders/film-live/film-job.json", JSON.stringify({ film_id: "film-live", audio_key: key }));
    const res = await call("DELETE", "/api/storyboard/audio-upload/" + nameOf(key));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { renders: string[] };
    expect(body.renders).toEqual(["film-live"]);
    expect(bucket.store.has(key)).toBe(true);
    // The film finishes: its sound is in the film now, so the bed is free.
    db.prepare(`UPDATE renders SET status = 'COMPLETED' WHERE job_id = 'film-live'`).run();
    expect((await call("DELETE", "/api/storyboard/audio-upload/" + nameOf(key))).status).toBe(200);
  });

  it("an unfinished film using a DIFFERENT bed does not hold this one; an unreadable doc does", async () => {
    const { db, bucket, call } = studio();
    const key = await upload(call);
    db.prepare(`INSERT INTO renders (job_id, project, status, submitted_at) VALUES ('film-other', 'p', 'IN_QUEUE', 1)`).run();
    await bucket.put("renders/film-other/film-job.json", JSON.stringify({ audio_key: "audio/someone-else.mp3" }));
    db.prepare(`INSERT INTO renders (job_id, project, status, submitted_at) VALUES ('film-junk', 'p', 'IN_PROGRESS', 1)`).run();
    await bucket.put("renders/film-junk/film-job.json", "{not json");
    const held = await call("DELETE", "/api/storyboard/audio-upload/" + nameOf(key));
    expect(held.status).toBe(409);
    expect(((await held.json()) as { renders: string[] }).renders).toEqual(["film-junk"]);
    db.prepare(`DELETE FROM renders WHERE job_id = 'film-junk'`).run();
    expect((await call("DELETE", "/api/storyboard/audio-upload/" + nameOf(key))).status).toBe(200);
  });

  it("refuses (503) rather than half-checking when more films are in flight than it reads", async () => {
    const { db, call } = studio();
    const key = await upload(call);
    const ins = db.prepare(`INSERT INTO renders (job_id, project, status, submitted_at) VALUES (?, 'p', 'IN_PROGRESS', 1)`);
    for (let i = 0; i <= IN_USE_SCAN_LIMIT; i++) ins.run(`film-${i}`);
    expect((await call("DELETE", "/api/storyboard/audio-upload/" + nameOf(key))).status).toBe(503);
  });
});

describe("cf#1016 the panel control", () => {
  const KEY = "audio/0b8f6c4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.mp3";

  it("is offered only for an uploaded bed, and builds the route's URL", () => {
    expect(audioBed.isUploadedBedKey(KEY)).toBe(true);
    expect(audioBed.isUploadedBedKey("audio/score-bed.mp3")).toBe(false);
    expect(audioBed.isUploadedBedKey("renders/x/narration.mp3")).toBe(false);
    expect(audioBed.isUploadedBedKey(null)).toBe(false);
    expect(audioBed.deleteUrl(KEY)).toBe("/api/storyboard/audio-upload/0b8f6c4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.mp3");
    expect(audioBed.deleteUrl("audio/score-bed.mp3")).toBeNull();
  });

  it("unlinks on a delete or an already-gone file, keeps the link on a refusal and says why", () => {
    expect(audioBed.deleteOutcome(200, { ok: true })).toEqual({ unlink: true, message: "audio file deleted." });
    expect(audioBed.deleteOutcome(404, {}).unlink).toBe(true);
    expect(audioBed.deleteOutcome(409, { renders: ["film-live"] })).toEqual({
      unlink: false,
      message: "not deleted: a render that has not finished uses this audio (film-live). Try again after it ends.",
    });
    expect(audioBed.deleteOutcome(503, { error: "too many renders" })).toEqual({ unlink: false, message: "not deleted: too many renders" });
    expect(audioBed.deleteOutcome(0, null)).toEqual({ unlink: false, message: "not deleted: HTTP 0" });
  });

  it("the planner loads the helper, shows the button, and wires it", () => {
    const html = readFileSync(join(ROOT, "public/planner.html"), "utf8");
    expect(html.indexOf('<script src="audio-bed.js"></script>')).toBeGreaterThan(-1);
    expect(html.indexOf('<script src="audio-bed.js"></script>')).toBeLessThan(html.indexOf('<script src="planner-audio.js"></script>'));
    expect(html).toContain('id="planner-audio-delete"');
    expect(readFileSync(join(ROOT, "public/planner-init.js"), "utf8")).toContain('audioDelete.addEventListener("click", deleteAudioFile)');
    const js = readFileSync(join(ROOT, "public/planner-audio.js"), "utf8");
    expect(js).toContain("del.hidden = !(window.audioBed && window.audioBed.isUploadedBedKey(planState.audioKey));");
  });
});
