import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";

const KEY = "renders/p/keyframes/j/shot_01.png";
const ctx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as never;

function setup(over: { transform?: () => Promise<ArrayBuffer>; images?: boolean } = {}) {
  const calls = { transforms: 0, widths: [] as unknown[], gets: 0 };
  const store = new Map([[KEY, { etag: "abc", bytes: new Uint8Array([1, 2, 3]) }]]);
  const env: Record<string, unknown> = {
    ALLOW_UNAUTHENTICATED: "true",
    R2_RENDERS: {
      head: async (k: string) => { const o = store.get(k); return o ? { etag: o.etag, httpEtag: `"${o.etag}"`, size: o.bytes.length, httpMetadata: {} } : null; },
      get: async (k: string) => { calls.gets += 1; const o = store.get(k); return o ? { body: new Blob([o.bytes]).stream(), etag: o.etag } : null; },
    },
  };
  if (over.images !== false) {
    env.IMAGES = {
      input: () => ({
        transform: (t: { width: number }) => {
          calls.transforms += 1;
          calls.widths.push(t.width);
          return { output: async () => ({ response: () => ({ arrayBuffer: over.transform ?? (async () => new Uint8Array([9, 9]).buffer) }) }) };
        },
      }),
    };
  }
  return { env, calls, store };
}
const get = (env: unknown, key = KEY, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://s.example/api/thumb/${key}`, { headers }), env as never, ctx);

/** A cache that behaves like caches.default: what goes in comes out, by URL. */
function fakeCache() {
  const m = new Map<string, Response>();
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      match: async (r: Request) => m.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => { m.set(r.url, res.clone()); },
    },
  };
  return m;
}

describe("GET /api/thumb", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as { caches?: unknown }).caches;
  });

  it("resizes to 360 wide, as a JPEG with its own etag", async () => {
    const { env, calls } = setup();
    const res = await get(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("etag")).toBe('"thumb-360-abc"');
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
    expect(calls.widths).toEqual([360]);
  });

  it("answers 304 to its own etag, with no transformation and no read of the original", async () => {
    const { env, calls } = setup();
    const res = await get(env, KEY, { "if-none-match": '"thumb-360-abc"' });
    expect(res.status).toBe(304);
    expect(calls.transforms).toBe(0);
    expect(calls.gets).toBe(0);
  });

  it("a second read comes from the cache, and costs no transformation", async () => {
    const m = fakeCache();
    const { env, calls } = setup();
    expect((await get(env)).status).toBe(200);
    await Promise.resolve();
    expect(m.size, "the instrument: it was stored").toBe(1);
    const res = await get(env);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
    expect(calls.transforms).toBe(1);
  });

  it("changed bytes at the same key miss the cache", async () => {
    fakeCache();
    const { env, calls, store } = setup();
    await get(env);
    await Promise.resolve();
    store.set(KEY, { etag: "def", bytes: new Uint8Array([4]) });
    const res = await get(env);
    expect(res.headers.get("etag")).toBe('"thumb-360-def"');
    expect(calls.transforms).toBe(2);
  });

  it("a broken cache still answers", async () => {
    (globalThis as unknown as { caches: unknown }).caches = {
      default: { match: async () => { throw new Error("cache down"); }, put: async () => { throw new Error("cache down"); } },
    };
    const { env } = setup();
    expect((await get(env)).status).toBe(200);
  });

  for (const [name, transform] of [
    ["a resize that throws", async () => { throw new Error("bad image"); }],
    ["a resize that gives nothing", async () => new ArrayBuffer(0)],
  ] as const) {
    it(`${name} answers 502 with the original's path, and no image`, async () => {
      const m = fakeCache();
      const { env } = setup({ transform });
      const res = await get(env);
      expect(res.status).toBe(502);
      expect(res.headers.get("content-type")).toMatch(/json/);
      const body = (await res.json()) as { error: string; original: string };
      expect(body.error).toMatch(/no thumbnail/);
      expect(body.original).toBe(`/api/artifact/${KEY}`);
      expect(m.size, "a failure is not cached").toBe(0);
    });
  }

  it("a caller without auth gets nothing, and costs no transformation", async () => {
    const { env, calls } = setup();
    delete env.ALLOW_UNAUTHENTICATED;
    env.AUTH_MODE = "token";
    env.STUDIO_API_TOKEN = "t";
    const res = await get(env);
    expect(res.status).toBe(403);
    expect(calls.transforms).toBe(0);
  });

  it("no binding answers 503 plainly", async () => {
    const { env } = setup({ images: false });
    const res = await get(env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/not bound/);
  });

  it("refuses what the artifact route refuses, and anything not a still", async () => {
    const { env, calls, store } = setup();
    store.set("renders/p/clips/a.mp4", { etag: "x", bytes: new Uint8Array([1]) });
    store.set("secrets/a.png", { etag: "x", bytes: new Uint8Array([1]) });
    for (const key of ["renders/p/clips/a.mp4", "secrets/a.png", "renders/../secrets/a.png", "renders/p/none.png"]) {
      expect((await get(env, key)).status, key).toBe(404);
    }
    expect(calls.transforms).toBe(0);
  });

  it("a guessed etag cannot show that an object outside the served space exists", async () => {
    const { env, store } = setup();
    store.set("secrets/a.png", { etag: "x", bytes: new Uint8Array([1]) });
    const res = await get(env, "secrets/a.png", { "if-none-match": '"thumb-360-x"' });
    expect(res.status).toBe(404);
  });
});
