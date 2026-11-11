import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// cf#1008. Cast delete leaked `cast/<id>/voice-line.wav` (no column names it), and a generated
// voice_ref_key was ONE key shared by every member, so it could not be freed. D1 is REAL SQLite with the
// repo migrations, so the reference count is the shipped SQL; R2 is an in-memory bucket with a paged
// list. The sample start is the one unit here that mocks the module registry, to read the shot id the
// talking door is sent.

const h = vi.hoisted(() => ({ invoked: [] as Array<Record<string, unknown>> }));
vi.mock("@skyphusion-labs/vivijure-core/modules/registry", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/modules/registry")>();
  return {
    ...actual,
    discoverModules: vi.fn(async () => [{ name: "talker", binding: "MODULE_TALKER", hooks: ["motion.backend"], usage: { native_audio: true } }]),
    resolveFetcher: vi.fn(() => ({ fetch: async () => new Response("{}") })),
    invokeModule: vi.fn(async (_f: unknown, req: Record<string, unknown>) => { h.invoked.push(req); return { ok: true, pending: true, poll: "p1" }; }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/presign", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/presign")>();
  return { ...actual, presignR2Get: vi.fn(async () => "https://r2/still.png") };
});

import worker from "../src/index";
import { deleteCastArtifacts } from "../src/cast-media";
import {
  isOwnGeneratedSampleKey,
  startCastVoiceSample,
  voiceSampleShotId,
  voiceSampleStateKey,
} from "../src/cast-voice-sample";
import { isLegacySharedVoiceSampleKey } from "../src/record-reclaim";
import type { CastMember } from "@skyphusion-labs/vivijure-core/cast-db";

const ROOT = join(__dirname, "..");
const LEGACY = "renders/cast/clips/voice-sample_cf-seedance.mp4";
const MP4 = (tag: number) => { const b = new Uint8Array(32); b[4] = 0x66; b[5] = 0x74; b[6] = 0x79; b[7] = 0x70; b[20] = tag; return b; };

function realD1() {
  const db = new DatabaseSync(":memory:");
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => { const r = db.prepare(sql).run(...(args as never[])); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { db, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: Array<{ run(): Promise<unknown> }>) => { const out = []; for (const s of ss) out.push(await s.run()); return out; } } };
}

/** In-memory R2. `list` pages at PAGE keys so a sweep that reads one page only leaves keys behind. */
const PAGE = 2;
function r2() {
  const store = new Map<string, { bytes: Uint8Array; type?: string }>();
  const deleted: string[] = [];
  const body = (key: string, v: { bytes: Uint8Array; type?: string }) => ({
    key,
    httpMetadata: { contentType: v.type },
    arrayBuffer: async () => v.bytes.slice().buffer,
    text: async () => new TextDecoder().decode(v.bytes),
  });
  return {
    store,
    deleted,
    async get(key: string) { const v = store.get(key); return v ? body(key, v) : null; },
    async head(key: string) { const v = store.get(key); return v ? { key, size: v.bytes.byteLength } : null; },
    async put(key: string, b: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer);
      store.set(key, { bytes, type: opts?.httpMetadata?.contentType });
      return { key };
    },
    async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) { store.delete(k); deleted.push(k); } },
    async list(o: { prefix?: string; cursor?: string } = {}) {
      const all = [...store.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort();
      const from = o.cursor ? Number(o.cursor) : 0;
      const page = all.slice(from, from + PAGE);
      const truncated = from + PAGE < all.length;
      return { objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: String(from + PAGE) } : {}) };
    },
  };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function studio() {
  const { db, d1 } = realD1();
  const bucket = r2();
  const env = { ALLOW_UNAUTHENTICATED: "true", DB: d1, R2_RENDERS: bucket, ASSETS: { fetch: async () => new Response("A") } };
  const call = (method: string, path: string, body?: BodyInit, type?: string) =>
    worker.fetch(new Request("https://studio.example" + path, { method, body, headers: type ? { "content-type": type } : {} }), env as never, ctx);
  const create = async (name: string) => {
    const res = await call("POST", "/api/cast", JSON.stringify({ name }), "application/json");
    expect(res.status).toBe(201);
    const pub = ((await res.json()) as { cast: { id: string } }).cast.id;
    const row = db.prepare("SELECT id, public_id FROM cast_members WHERE public_id = ?").get(pub) as { id: number; public_id: string };
    return row;
  };
  const voiceRef = (id: number) => (db.prepare("SELECT voice_ref_key AS k FROM cast_members WHERE id = ?").get(id) as { k: string | null } | undefined)?.k ?? null;
  return { db, env, bucket, call, create, voiceRef };
}

/** What a finished sample leaves in R2: the module's clip and the state doc that names it. */
async function finishedSample(bucket: ReturnType<typeof r2>, publicId: string, clipKey: string, tag: number) {
  await bucket.put(clipKey, MP4(tag), { httpMetadata: { contentType: "video/mp4" } });
  await bucket.put(voiceSampleStateKey(publicId), JSON.stringify({ poll: "p", binding: "MODULE_TALKER", module_name: "talker", clip_key: clipKey }));
}
const ownClip = (publicId: string) => `renders/cast/clips/${voiceSampleShotId(publicId)}_talker.mp4`;

beforeEach(() => { h.invoked = []; });

describe("cf#1008 the generated sample key is per member", () => {
  it("each member's sample is generated under its own shot id", async () => {
    const { env, create, db } = studio();
    const a = await create("Ada");
    const b = await create("Bo");
    for (const m of [a, b]) db.prepare("UPDATE cast_members SET portrait_key = ? WHERE id = ?").run(`cast/${m.id}/portrait.png`, m.id);
    await startCastVoiceSample(env as never, a.id, {});
    await startCastVoiceSample(env as never, b.id, {});
    const shots = h.invoked.map((r) => (r.input as { shot_id: string }).shot_id);
    expect(shots).toEqual([voiceSampleShotId(a.public_id), voiceSampleShotId(b.public_id)]);
    expect(shots[0]).not.toBe(shots[1]);
  });

  it("isOwnGeneratedSampleKey matches only this member's clip, never the legacy shared key", () => {
    const pid = "6b1f0a3c-9d2e-4a7b-8c1d-2e3f4a5b6c7d";
    expect(isOwnGeneratedSampleKey(pid, ownClip(pid))).toBe(true);
    expect(isOwnGeneratedSampleKey(pid, LEGACY)).toBe(false);
    expect(isOwnGeneratedSampleKey(pid, ownClip("other-id"))).toBe(false);
    expect(isOwnGeneratedSampleKey(pid, `renders/cast/clips/${voiceSampleShotId(pid)}_x/y.mp4`)).toBe(false);
    expect(isOwnGeneratedSampleKey("", LEGACY)).toBe(false);
    expect(isLegacySharedVoiceSampleKey(LEGACY)).toBe(true);
    expect(isLegacySharedVoiceSampleKey(ownClip(pid))).toBe(false);
  });
});

describe("cf#1008 keep copies the sample into the member's own tree", () => {
  it("two members keep two objects; B keeping does not change A's", async () => {
    const { bucket, call, create, voiceRef } = studio();
    const a = await create("Ada");
    const b = await create("Bo");
    await finishedSample(bucket, a.public_id, ownClip(a.public_id), 1);
    const ka = await call("POST", `/api/cast/${a.public_id}/voice-sample/keep`);
    expect(ka.status).toBe(200);
    expect(await ka.json()).toEqual({ voice_ref_key: `cast/${a.id}/voice-ref.mp4` });
    await finishedSample(bucket, b.public_id, ownClip(b.public_id), 2);
    expect((await call("POST", `/api/cast/${b.public_id}/voice-sample/keep`)).status).toBe(200);
    expect(voiceRef(a.id)).toBe(`cast/${a.id}/voice-ref.mp4`);
    expect(voiceRef(b.id)).toBe(`cast/${b.id}/voice-ref.mp4`);
    expect(bucket.store.get(`cast/${a.id}/voice-ref.mp4`)?.bytes[20]).toBe(1);
    expect(bucket.store.get(`cast/${b.id}/voice-ref.mp4`)?.bytes[20]).toBe(2);
    // The spent clip and state doc are freed.
    expect(bucket.store.has(ownClip(a.public_id))).toBe(false);
    expect(bucket.store.has(voiceSampleStateKey(a.public_id))).toBe(false);
  });

  it("a state doc from before cf#1008 is copied, and the shared legacy clip is NOT deleted", async () => {
    const { bucket, call, create, voiceRef } = studio();
    const a = await create("Ada");
    await finishedSample(bucket, a.public_id, LEGACY, 7);
    expect((await call("POST", `/api/cast/${a.public_id}/voice-sample/keep`)).status).toBe(200);
    expect(voiceRef(a.id)).toBe(`cast/${a.id}/voice-ref.mp4`);
    expect(bucket.store.has(LEGACY)).toBe(true);
  });

  it("a sample gone from storage is a 400, and the row is not changed", async () => {
    const { bucket, call, create, voiceRef } = studio();
    const a = await create("Ada");
    await finishedSample(bucket, a.public_id, ownClip(a.public_id), 1);
    bucket.store.delete(ownClip(a.public_id));
    expect((await call("POST", `/api/cast/${a.public_id}/voice-sample/keep`)).status).toBe(400);
    expect(voiceRef(a.id)).toBeNull();
  });
});

describe("cf#1008 cast delete sweeps the member's own trees", () => {
  it("frees voice-line.wav, every key under cast/<id>/ and cast-gen/<id>/ across pages, and the sample in flight", async () => {
    const { bucket, call, create, db } = studio();
    const a = await create("Ada");
    const b = await create("Bo");
    const id = a.id;
    const mine = [
      `cast/${id}/voice-line.wav`, `cast/${id}/voice-ref.mp4`, `cast/${id}/portrait.png`,
      `cast/${id}/refs/r1.png`, `cast/${id}/sources/s1.png`, `cast/${id}/unnamed-by-any-column.bin`,
      `cast-gen/${id}/job-1.refs-job.json`, `cast-gen/${id}/job-2.refs-job.json`,
    ];
    const notMine = [`cast/${b.id}/voice-line.wav`, `cast/${id}0/portrait.png`, `cast-gen/${b.id}/job.json`, LEGACY, "renders/p/clips/s_x.mp4"];
    for (const k of [...mine, ...notMine]) await bucket.put(k, "x");
    db.prepare("UPDATE cast_members SET lora_key = ?, voice_ref_key = ? WHERE id = ?").run("loras/lora-ada-1782009575/lora.safetensors", `cast/${id}/voice-ref.mp4`, id);
    await bucket.put("loras/lora-ada-1782009575/lora.safetensors", "x");
    await finishedSample(bucket, a.public_id, ownClip(a.public_id), 3);

    const res = await call("DELETE", `/api/cast/${a.public_id}`);
    expect(res.status).toBe(200);
    for (const k of mine) expect(bucket.store.has(k), k).toBe(false);
    expect(bucket.store.has("loras/lora-ada-1782009575/lora.safetensors")).toBe(false);
    expect(bucket.store.has(ownClip(a.public_id))).toBe(false);
    expect(bucket.store.has(voiceSampleStateKey(a.public_id))).toBe(false);
    for (const k of notMine) expect(bucket.store.has(k), k).toBe(true);
  });

  it("a legacy shared voice_ref_key is kept while another member names it, and freed with the last one", async () => {
    const { bucket, call, create, db } = studio();
    const a = await create("Ada");
    const b = await create("Bo");
    await bucket.put(LEGACY, "x");
    db.prepare("UPDATE cast_members SET voice_ref_key = ?").run(LEGACY);
    expect((await call("DELETE", `/api/cast/${a.public_id}`)).status).toBe(200);
    expect(bucket.store.has(LEGACY)).toBe(true);
    expect((await call("DELETE", `/api/cast/${b.public_id}`)).status).toBe(200);
    expect(bucket.store.has(LEGACY)).toBe(false);
  });

  it("a voice_ref_key in neither shape is never deleted, even with no other row naming it", async () => {
    const { bucket, call, create, db } = studio();
    const a = await create("Ada");
    await bucket.put("renders/real-project/clips/shot_01_x.mp4", "x");
    db.prepare("UPDATE cast_members SET voice_ref_key = ? WHERE id = ?").run("renders/real-project/clips/shot_01_x.mp4", a.id);
    expect((await call("DELETE", `/api/cast/${a.public_id}`)).status).toBe(200);
    expect(bucket.store.has("renders/real-project/clips/shot_01_x.mp4")).toBe(true);
  });

  it("a failed list still frees every key a column names, owned voice_ref_key included", async () => {
    const bucket = r2();
    bucket.list = async () => { throw new Error("list down"); };
    const named = ["cast/4/portrait.png", "cast/4/refs/r.png", "cast/4/sources/s.png", "cast/4/voice-ref.mp4", "loras/l/lora.safetensors"];
    for (const k of named) await bucket.put(k, "x");
    const env = { DB: realD1().d1, R2_RENDERS: bucket };
    const cast = {
      id: 4, public_id: "p4", portrait_key: named[0], ref_keys: [{ key: named[1] }], source_keys: [{ key: named[2] }],
      lora_key: named[4], wan_lora_key_high: null, wan_lora_key_low: null, voice_ref_key: named[3],
    } as unknown as CastMember;
    await deleteCastArtifacts(env as never, cast);
    for (const k of named) expect(bucket.store.has(k), k).toBe(false);
  });

  it("a failed reference count keeps the legacy shared key", async () => {
    const bucket = r2();
    await bucket.put(LEGACY, "x");
    const env = { DB: { prepare: () => { throw new Error("D1 down"); } }, R2_RENDERS: bucket };
    const cast = { id: 4, public_id: "p4", portrait_key: null, ref_keys: [], source_keys: [], lora_key: null, wan_lora_key_high: null, wan_lora_key_low: null, voice_ref_key: LEGACY } as unknown as CastMember;
    await deleteCastArtifacts(env as never, cast);
    expect(bucket.store.has(LEGACY)).toBe(true);
  });
});
