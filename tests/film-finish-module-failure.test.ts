import { afterEach, describe, expect, it, vi } from "vitest";
import titles from "../modules/film-titles/src/index";
import subtitle from "../modules/subtitle/src/index";
import { studioEnv } from "../src/orchestrator-env";
import type { Env } from "../src/env";

// What a film.finish module reports for each answer from the door. The core acts on `failure`, so a wrong
// word here either ships a film without its step or holds a film for hours on a fault no wait can cure.

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Mod = { fetch(req: Request, env: unknown): Promise<Response> };
const CASES: [string, Mod, Record<string, unknown>][] = [
  ["film-titles", titles as unknown as Mod, { title: { text: "T" } }],
  ["subtitle", subtitle as unknown as Mod, { captions: [{ start: 0, end: 1, text: "hi" }] }],
];
const base = { film_key: "renders/p/film.mp4", video_url: "https://g/f", output_url: "https://p/o", output_key: "renders/p/film-ff0.mp4", sidecar_url: "https://p/s" };
const ENV = { VIDEO_FINISH_URL: "https://door.test", MEDIA_FINISH_TOKEN: "t" };

async function invoke(mod: Mod, input: Record<string, unknown>, env: unknown = ENV) {
  const resp = await mod.fetch(
    new Request("https://m/invoke", { method: "POST", body: JSON.stringify({ hook: "film.finish", input: { ...base, ...input }, config: {}, context: { project: "p", job_id: "film-1" } }) }),
    env,
  );
  return (await resp.json()) as { ok: boolean; pending?: boolean; output?: { film_key: string; degraded?: string; failure?: { kind: string; code: string } } };
}

describe.each(CASES)("%s", (_name, mod, input) => {
  const door = (status: number, body = "{}") => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));

  it("no capacity is a transient capacity failure, and the sync route is not tried", async () => {
    door(429);
    const r = await invoke(mod, input);
    expect(r.output?.failure).toMatchObject({ kind: "transient", code: "capacity" });
    expect(r.output?.film_key).toBe(base.film_key);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("a 5xx is transient, on the short bound", async () => {
    door(503);
    expect((await invoke(mod, input)).output?.failure).toMatchObject({ kind: "transient", code: "server_error" });
  });

  it("a 401 is permanent, because no wait cures a bad token", async () => {
    door(401);
    expect((await invoke(mod, input)).output?.failure).toMatchObject({ kind: "permanent", code: "refused" });
  });

  it("an unreachable door is transient, not capacity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect((await invoke(mod, input)).output?.failure).toMatchObject({ kind: "transient", code: "unreachable" });
  });

  it("no door configured is permanent", async () => {
    expect((await invoke(mod, input, {})).output?.failure).toMatchObject({ kind: "permanent", code: "not_configured" });
  });

  it("an accepted job reports no failure", async () => {
    door(202, JSON.stringify({ ok: true, jobId: "j" }));
    const r = await invoke(mod, input);
    expect(r.pending).toBe(true);
    expect(r.output).toBeUndefined();
  });

  it("a no-op carries no failure, so a film with nothing to card stays clean", async () => {
    const r = await invoke(mod, {});
    expect(r.output?.failure).toBeUndefined();
    expect(r.output?.degraded).toBeUndefined();
  });
});

describe("studioEnv", () => {
  const raw = (over: Partial<Env> = {}) => ({ DB: { prepare: () => { throw new Error("no such table: finish_queue"); } }, ...over }) as unknown as Env;

  it("binds the queue on any deploy with a database", () => {
    expect(typeof (studioEnv(raw()) as { FINISH_QUEUE?: { acquire: unknown } }).FINISH_QUEUE?.acquire).toBe("function");
  });
  it("binds nothing with no database, which is today's retry", () => {
    expect((studioEnv({} as Env) as { FINISH_QUEUE?: unknown }).FINISH_QUEUE).toBeUndefined();
  });
  it("reuses one queue across requests on one env", () => {
    const env = raw();
    const a = (studioEnv(env) as { FINISH_QUEUE?: unknown }).FINISH_QUEUE;
    expect((studioEnv(env) as { FINISH_QUEUE?: unknown }).FINISH_QUEUE).toBe(a);
  });
});
