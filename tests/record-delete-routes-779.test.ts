import { describe, it, expect, vi, beforeEach } from "vitest";

// cf#779 (LG-2/LG-3), the ROUTE half. tests/record-delete-r2-reclaim-779.test.ts proves the reclaim
// engine frees the right objects and holds back the wrong ones. That is not the same claim as
// "DELETE /api/storyboard/renders/:id frees them", and the defect this issue exists to fix lived
// exactly in that gap: the engine did not exist and the handler was two lines that dropped a row.
//
// So these drive the real Worker through `worker.fetch` and assert on BUCKET CONTENTS plus the
// ORDERING CONTRACT:
//
//   on success   the objects are gone AND the row is gone
//   on failure   the objects that remain are still NAMED by a row that is STILL THERE
//
// The second is the one that matters. The D1 row is the only index of a render's keys, so a handler
// that drops the row and then fails to free the bytes has produced an invisible permanent leak. A
// test that only checks the happy path cannot tell that handler from this one.

const deleteRenderRow = vi.fn();
const deleteProject = vi.fn();

vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return {
    ...actual,
    getRenderIdByPublicId: async (_e: unknown, pid: string) => (pid === RENDER_PID ? 1 : null),
    deleteRenderRow: (...a: unknown[]) => deleteRenderRow(...a),
  };
});

vi.mock("@skyphusion-labs/vivijure-core/storyboard-projects-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skyphusion-labs/vivijure-core/storyboard-projects-db")>();
  return {
    ...actual,
    getProjectIdByPublicId: async (_e: unknown, pid: string) => (pid === PROJECT_PID ? 7 : null),
    getProjectById: async (_e: unknown, id: number) => (id === 7 && !projectRowMissing ? { id: 7, public_id: PROJECT_PID, slug: "heist", name: "heist", prefs: {}, last_storyboard: null, created_at: "t", updated_at: "t" } : null),
    deleteProject: (...a: unknown[]) => deleteProject(...a),
  };
});

/** Set by the stale-index case: the public-id lookup still resolves, the row is gone. */
let projectRowMissing = false;

const RENDER_PID = "11111111-1111-4111-8111-111111111111";
const PROJECT_PID = "77777777-7777-4777-8777-777777777777";
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const ROW = {
  id: 1,
  job_id: "film-aaa",
  project: "heist",
  bundle_key: "bundles/heist-abc.tar.gz",
  output_key: "renders/film-aaa/film.mp4",
  keyframes_json: null,
  output_json: null,
  project_id: 7,
};

function makeEnv(opts: { failDelete?: string } = {}) {
  const store = new Set<string>([
    "renders/film-aaa/film.mp4",
    "renders/film-aaa/film-job.json",
    "renders/logs/film-aaa.txt",
    "bundles/heist-abc.tar.gz",
  ]);
  const rows = [{ ...ROW }];
  const shotRows = [{ film_id: "film-aaa", still_key: null, wav_key: null, clip_key: "renders/heist/clips/s1_wan.mp4" }];
  store.add("renders/heist/clips/s1_wan.mp4");
  const ddl: string[] = [];
  const ledgerDrops: string[] = [];

  const env = {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    R2_RENDERS: {
      list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
        objects: [...store].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key, size: 1 })),
        truncated: false,
      }),
      get: async (key: string) => (key === "renders/film-aaa/film-job.json" ? { text: async () => JSON.stringify({ film_id: "film-aaa", project: "heist", shots: [] }) } : null),
      head: async (key: string) => (store.has(key) ? { size: 1 } : null),
      delete: async (key: string) => {
        if (opts.failDelete && key === opts.failDelete) throw new Error("simulated R2 delete failure");
        store.delete(key);
      },
      put: async (key: string) => { store.add(key); },
    },
    DB: {
      prepare(sql: string) {
        const flat = sql.replace(/\s+/g, " ").trim();
        let args: unknown[] = [];
        const stmt = {
          bind(...a: unknown[]) { args = a; return stmt; },
          async all<T>() {
            ddl.push(flat);
            if (/FROM renders WHERE id IN/.test(flat)) return { results: rows.filter((r) => (args as number[]).includes(r.id)) as unknown as T[] };
            if (/FROM renders WHERE id NOT IN/.test(flat)) return { results: rows.filter((r) => !(args as number[]).includes(r.id)) as unknown as T[] };
            if (/FROM renders WHERE project_id =/.test(flat)) return { results: rows.filter((r) => r.project_id === args[0]) as unknown as T[] };
            if (/FROM shot_records WHERE film_id IN/.test(flat)) return { results: shotRows.filter((s) => (args as string[]).includes(s.film_id)) as unknown as T[] };
            if (/FROM shot_records WHERE film_id =/.test(flat)) return { results: shotRows.filter((s) => s.film_id === args[0]) as unknown as T[] };
            throw new Error(`unstubbed all(): ${flat}`);
          },
          async run() {
            ddl.push(flat);
            if (/DELETE FROM shot_records/.test(flat) || /DELETE FROM renders/.test(flat)) return { meta: { changes: 1 } };
            // The storage ledger (migration 0013). Recorded, not merely tolerated: it is the proof
            // that these deletes go through the METERED binding. A reclaim that used a raw bucket
            // handle would free the bytes and leave a ledger row per object, so accounted usage
            // would read permanently HIGH and a quota studio would wedge at a ceiling it is under.
            if (/DELETE FROM storage_usage WHERE object_key = /.test(flat)) {
              ledgerDrops.push(String(args[0]));
              return { meta: { changes: 1 } };
            }
            throw new Error(`unstubbed run(): ${flat}`);
          },
          async first<T>() {
            ddl.push(flat);
            if (/COUNT\(\*\) AS n FROM renders WHERE output_key/.test(flat)) {
              const [key, id] = args as [string, number];
              return { n: rows.filter((r) => r.output_key === key && r.id !== id).length } as unknown as T;
            }
            throw new Error(`unstubbed first(): ${flat}`);
          },
        };
        return stmt;
      },
    },
  } as unknown as never;
  return { env, store, ddl, ledgerDrops };
}

let worker: typeof import("../src/index").default;

beforeEach(async () => {
  projectRowMissing = false;
  deleteRenderRow.mockReset().mockResolvedValue(true);
  deleteProject.mockReset().mockResolvedValue({ id: 7, public_id: PROJECT_PID, slug: "heist", name: "heist" });
  worker = (await import("../src/index")).default;
});

describe("DELETE /api/storyboard/renders/:id frees its stored files (cf#779)", () => {
  it("CONTROL: the objects are freed AND the row is dropped", async () => {
    const { env, store, ledgerDrops } = makeEnv();
    const res = await worker.fetch(
      new Request(`https://studio.example/api/storyboard/renders/${RENDER_PID}`, { method: "DELETE" }),
      env, ctx,
    );
    const body = await res.json() as { ok?: boolean; objects_freed?: number };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    // Pre-fix: every one of these survived and the row was gone, so nothing could name them again.
    expect([...store], `objects_freed=${body.objects_freed}`).toEqual([]);
    expect(deleteRenderRow, "the row must be dropped once the bytes are gone").toHaveBeenCalledTimes(1);
    expect(body.objects_freed).toBeGreaterThan(0);
    // Every freed object left the storage ledger too, so accounted usage follows the bytes.
    expect(ledgerDrops.sort(), "a freed object stayed on the storage ledger").toEqual([
      "bundles/heist-abc.tar.gz",
      "renders/film-aaa/film-job.json",
      "renders/film-aaa/film.mp4",
      "renders/heist/clips/s1_wan.mp4",
      "renders/logs/film-aaa.txt",
    ]);
  });

  it("CONTROL (the ordering contract): a failed R2 delete KEEPS the row and answers 409", async () => {
    const { env, store } = makeEnv({ failDelete: "bundles/heist-abc.tar.gz" });
    const res = await worker.fetch(
      new Request(`https://studio.example/api/storyboard/renders/${RENDER_PID}`, { method: "DELETE" }),
      env, ctx,
    );
    const body = await res.json() as { error?: string; failed?: number };
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toMatch(/reclaim incomplete/);
    // THE CLAIM. The object that could not be freed is still named by a row that still exists, so a
    // retry can find it. Reverse the ordering and this row is gone with the object still in place.
    expect([...store], "the unfreed object vanished from the bucket").toContain("bundles/heist-abc.tar.gz");
    expect(deleteRenderRow, "the row was dropped despite an incomplete reclaim").not.toHaveBeenCalled();
  });

  it("an unknown render is still a 404 and frees nothing", async () => {
    const { env, store } = makeEnv();
    const before = [...store].sort();
    const res = await worker.fetch(
      new Request("https://studio.example/api/storyboard/renders/99999999-9999-4999-8999-999999999999", { method: "DELETE" }),
      env, ctx,
    );
    expect(res.status).toBe(404);
    expect([...store].sort()).toEqual(before);
  });
});

describe("DELETE /api/storyboard/projects/:id frees its stored files (cf#779)", () => {
  it("CONTROL: the project's renders are reclaimed and dropped with it", async () => {
    const { env, store } = makeEnv();
    const res = await worker.fetch(
      new Request(`https://studio.example/api/storyboard/projects/${PROJECT_PID}`, { method: "DELETE" }),
      env, ctx,
    );
    const body = await res.json() as { ok?: boolean; renders_deleted?: number; objects_freed?: number };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.renders_deleted, "a project's bytes ARE its renders' artifacts").toBe(1);
    expect([...store], `objects_freed=${body.objects_freed}`).toEqual([]);
    expect(deleteProject).toHaveBeenCalledTimes(1);
  });

  it("CONTROL (the ordering contract): a failed R2 delete KEEPS the project and answers 409", async () => {
    const { env, store } = makeEnv({ failDelete: "renders/logs/film-aaa.txt" });
    const res = await worker.fetch(
      new Request(`https://studio.example/api/storyboard/projects/${PROJECT_PID}`, { method: "DELETE" }),
      env, ctx,
    );
    expect(res.status).toBe(409);
    expect([...store]).toContain("renders/logs/film-aaa.txt");
    expect(deleteProject, "the project row was dropped despite an incomplete reclaim").not.toHaveBeenCalled();
  });

  it("CONTROL: a public id that resolves to a MISSING row cascades nothing", async () => {
    // `renders.project_id` is a logical FK with no constraint, so a previously-deleted project's id
    // can still sit on render rows. This is the reachable shape of that: the public-id index hands
    // back an id whose project row is gone (a stale read, or the row deleted between the two
    // lookups). Without the existence check the cascade runs on that id and deletes the strays.
    const { env, store } = makeEnv();
    projectRowMissing = true;
    const before = [...store].sort();
    const res = await worker.fetch(
      new Request(`https://studio.example/api/storyboard/projects/${PROJECT_PID}`, { method: "DELETE" }),
      env, ctx,
    );
    expect(res.status).toBe(404);
    expect([...store].sort(), "a project row that does not exist still cascaded its renders").toEqual(before);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("an unknown project cascades NOTHING, because project_id is a logical FK with strays behind it", async () => {
    // `renders.project_id` has no constraint, so a previously-deleted project's id can still sit on
    // render rows. A cascade keyed on an unverified id would delete those strays on a 404.
    const { env, store } = makeEnv();
    const before = [...store].sort();
    const res = await worker.fetch(
      new Request("https://studio.example/api/storyboard/projects/88888888-8888-4888-8888-888888888888", { method: "DELETE" }),
      env, ctx,
    );
    expect(res.status).toBe(404);
    expect([...store].sort(), "a 404 touched the bucket").toEqual(before);
    expect(deleteProject).not.toHaveBeenCalled();
  });
});
