import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import {
  createTierReadiness,
  observeTierReadiness,
  type ReadinessDeps,
  type TierReadiness,
} from "../src/tier-readiness";
import { API_ROUTES } from "../src/studio";

// cf#887: the on-demand video-finish readiness read. Two halves: every state driven from a stub
// (proves the DECISION path), and the import-graph scan with planted controls (proves the never-uses
// list holds in the real tree). A stub cannot prove the shipped artifact; the live read per state is
// the deploy-time half and is listed in the PR.

const TOKEN = "readiness-test-token";
const MAX = "Failed to start container: Maximum number of running container instances exceeded.";

type Call = { instance: string; path: string; auth: string | null };
type Reply = Response | Error | "hang";

/** A FINISH_CONTAINER namespace that records which INSTANCE each call addressed. */
function boundEnv(reply: (path: string) => Reply, token: string | undefined = TOKEN) {
  const calls: Call[] = [];
  const ns = {
    idFromName: (name: string) => ({ __name: name }),
    get: (id: { __name: string }) => ({
      fetch: async (url: string, init: RequestInit = {}) => {
        const path = new URL(url).pathname;
        calls.push({ instance: id.__name, path, auth: new Headers(init.headers).get("authorization") });
        const r = reply(path);
        if (r === "hang") return new Promise<Response>(() => {});
        if (r instanceof Error) throw r;
        return r;
      },
    }),
  };
  return { env: { FINISH_CONTAINER: ns as never, MEDIA_FINISH_TOKEN: token }, calls };
}

function urlDeps(reply: (path: string) => Reply, over: Partial<ReadinessDeps> = {}) {
  const calls: Call[] = [];
  const deps = testDeps({
    fetch: async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      calls.push({ instance: u.host, path: u.pathname, auth: new Headers(init.headers).get("authorization") });
      const r = reply(u.pathname);
      if (r === "hang") return new Promise<Response>(() => {});
      if (r instanceof Error) throw r;
      return r;
    },
    ...over,
  });
  return { deps, calls };
}

function testDeps(over: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    now: () => Date.now(),
    fetch: async () => {
      throw new Error("no URL door in this test");
    },
    poolIndex: () => 0,
    budgetMs: 2_000,
    cacheTtlMs: 30_000,
    ...over,
  };
}

const ok = () => Response.json({ ok: true });
const authed = (bearer = "verified") => Response.json({ ok: true, serving: true, bearer, liveness_only: true });
const unauthorized = () => Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

afterEach(() => vi.restoreAllMocks());

describe("cf#887 states, bound door (FINISH_CONTAINER)", () => {
  it("SERVING: /health 200, then /auth-check accepted the bearer; only the sync pool is addressed", async () => {
    const { env, calls } = boundEnv((p) => (p === "/health" ? ok() : authed()));
    const r = await observeTierReadiness(env, testDeps());
    expect(r.state).toBe("SERVING");
    expect(r.liveness_only).toBe(true);
    expect(r.door).toBe("bound");
    expect(r.instance).toBe("sync-0");
    expect(r.bearer).toBe("verified");
    expect(calls.map((c) => c.path)).toEqual(["/health", "/auth-check"]);
    // The bearer rides only the authed read, and every call went to a pool instance, never a job one.
    expect(calls[0].auth).toBeNull();
    expect(calls[1].auth).toBe("Bearer " + TOKEN);
    expect(calls.every((c) => c.instance.startsWith("sync-"))).toBe(true);
    // Nothing in the answer carries the token.
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("never probes /async/status: that read is answered 404 by the binding over a dead container", async () => {
    const { env, calls } = boundEnv((p) => (p === "/health" ? ok() : authed()));
    await observeTierReadiness(env, testDeps());
    expect(calls.some((c) => c.path.startsWith("/async/"))).toBe(false);
  });

  it("NOT_SERVING: a platform start error at /health (the cf#851 shape)", async () => {
    const { env, calls } = boundEnv(() => new Error("Failed to start container: the container process exited"));
    const r = await observeTierReadiness(env, testDeps());
    expect(r.state).toBe("NOT_SERVING");
    expect(r.observations[0].error_text).toContain("exited");
    expect(calls.map((c) => c.path)).toEqual(["/health"]);
  });

  it("NOT_SERVING: /health non-200", async () => {
    const { env } = boundEnv(() => new Response("boom", { status: 500 }));
    const r = await observeTierReadiness(env, testDeps());
    expect(r.state).toBe("NOT_SERVING");
    expect(r.observations[0]).toMatchObject({ route: "/health", status: 500, error_text: "boom" });
  });

  it("NOT_SERVING: /auth-check 401 is the container's refusal on the bound door", async () => {
    const { env } = boundEnv((p) => (p === "/health" ? ok() : unauthorized()));
    const r = await observeTierReadiness(env, testDeps());
    expect(r.state).toBe("NOT_SERVING");
    expect(r.refused_by).toBe("container");
  });

  it.each([
    ["a 500 carrying the instance-limit text", () => new Response(MAX, { status: 500 })],
    ["a thrown instance-limit error", () => new Error(MAX)],
    ["a 429", () => new Response("", { status: 429 })],
  ])("AT_CAPACITY: %s", async (_n, make) => {
    const { env } = boundEnv(() => make());
    const r = await observeTierReadiness(env, testDeps());
    expect(r.state).toBe("AT_CAPACITY");
  });

  it("UNKNOWN, not NOT_SERVING, when the budget runs out first", async () => {
    const { env } = boundEnv(() => "hang");
    const r = await observeTierReadiness(env, testDeps({ budgetMs: 25 }));
    expect(r.state).toBe("UNKNOWN");
    expect(r.observations[0]).toMatchObject({ route: "/health", status: null, timed_out: true });
  });

  it("UNKNOWN when the image predates /auth-check (404): bearer acceptance is unobserved", async () => {
    const { env } = boundEnv((p) => (p === "/health" ? ok() : new Response("not found", { status: 404 })));
    const r = await observeTierReadiness(env, testDeps());
    expect(r.state).toBe("UNKNOWN");
  });

  it("UNKNOWN when /auth-check answers 200 with no known shape", async () => {
    const { env } = boundEnv((p) => (p === "/health" ? ok() : Response.json({ hello: 1 })));
    const r = await observeTierReadiness(env, testDeps());
    expect(r.state).toBe("UNKNOWN");
  });

  it("UNKNOWN with NO call made when no token is readable", async () => {
    const { env, calls } = boundEnv(() => ok(), "");
    const r = await observeTierReadiness(env, testDeps());
    expect(r.state).toBe("UNKNOWN");
    expect(calls).toEqual([]);
  });

  it("SERVING reports a disabled bearer gate honestly instead of calling it verified", async () => {
    const { env } = boundEnv((p) => (p === "/health" ? ok() : authed("disabled")));
    const r = await observeTierReadiness(env, testDeps());
    expect(r.state).toBe("SERVING");
    expect(r.bearer).toBe("disabled");
    expect(r.reason).toContain("disabled");
  });
});

describe("cf#887 states, URL door (VIDEO_FINISH_URL)", () => {
  const env = { VIDEO_FINISH_URL: "https://finish.example.test/", MEDIA_FINISH_TOKEN: TOKEN };

  it("SERVING over the origin, with /ready as a pre-check that does not replace the authed read", async () => {
    const { deps, calls } = urlDeps((p) =>
      p === "/ready" ? Response.json({ ok: true, token_configured: true }) : p === "/health" ? ok() : authed(),
    );
    const r = await observeTierReadiness(env, deps);
    expect(r.state).toBe("SERVING");
    expect(r.door).toBe("url");
    expect(r.instance).toBe("finish.example.test");
    expect(calls.map((c) => c.path)).toEqual(["/health", "/ready", "/auth-check"]);
  });

  it("a 401 when the door Worker says it holds no token is the Worker's own refusal", async () => {
    const { deps } = urlDeps((p) =>
      p === "/ready" ? Response.json({ ok: true, token_configured: false }) : p === "/health" ? ok() : unauthorized(),
    );
    const r = await observeTierReadiness(env, deps);
    expect(r.state).toBe("NOT_SERVING");
    expect(r.refused_by).toBe("door_worker");
  });

  it("a 401 otherwise cannot be attributed: the two 401 bodies are identical", async () => {
    const { deps } = urlDeps((p) =>
      p === "/ready" ? Response.json({ ok: true, token_configured: true }) : p === "/health" ? ok() : unauthorized(),
    );
    const r = await observeTierReadiness(env, deps);
    expect(r.refused_by).toBe("door_worker_or_container");
  });

  it("a self-host origin with no /ready still answers", async () => {
    const { deps } = urlDeps((p) => (p === "/ready" ? new Response("", { status: 404 }) : p === "/health" ? ok() : authed()));
    const r = await observeTierReadiness(env, deps);
    expect(r.state).toBe("SERVING");
  });

  it("UNKNOWN with no call when there is no binding and no usable URL", async () => {
    const { deps, calls } = urlDeps(() => ok());
    const r = await observeTierReadiness({ VIDEO_FINISH_URL: "placeholder", MEDIA_FINISH_TOKEN: TOKEN }, deps);
    expect(r.state).toBe("UNKNOWN");
    expect(r.door).toBe("none");
    expect(calls).toEqual([]);
  });

  it("the binding wins over the URL", async () => {
    const { env: bound } = boundEnv((p) => (p === "/health" ? ok() : authed()));
    const { deps, calls } = urlDeps(() => ok());
    const r = await observeTierReadiness({ ...bound, VIDEO_FINISH_URL: "https://finish.example.test" }, deps);
    expect(r.door).toBe("bound");
    expect(calls).toEqual([]);
  });
});

describe("cf#887 single-flight and the 30 s reuse", () => {
  it("concurrent reads share one set of calls; a read inside the TTL is cached; after it, fresh", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let t = 1_000_000;
    const { env, calls } = boundEnv((p) => (p === "/health" ? ok() : authed()));
    const read = createTierReadiness(testDeps({ now: () => t }));
    const [a, b] = await Promise.all([read(env), read(env)]);
    expect(calls).toHaveLength(2);
    expect(a.state).toBe("SERVING");
    expect(b.state).toBe("SERVING");
    t += 10_000;
    const c: TierReadiness = await read(env);
    expect(c.cached).toBe(true);
    expect(calls).toHaveLength(2);
    t += 30_000;
    const d = await read(env);
    expect(d.cached).toBe(false);
    expect(calls).toHaveLength(4);
  });

  it("logs one tier_readiness line per fresh read, never the token", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: unknown) => void lines.push(String(s)));
    const { env } = boundEnv((p) => (p === "/health" ? ok() : authed()));
    await createTierReadiness(testDeps())(env);
    expect(lines.filter((l) => l.includes('"ev":"tier_readiness"'))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});

describe("cf#887 route wiring", () => {
  it("is one operator-scope GET row", () => {
    const rows = API_ROUTES.filter((r) => r.pattern === "/api/tiers/video-finish/readiness");
    expect(rows.map((r) => `${r.method} ${r.scope}`)).toEqual(["GET operator"]);
  });
});

// ---------------------------------------------------------------------------------------------
// THE NEVER-USES LIST, enforced on the real tree. Only src/studio.ts (the route table) may import
// src/tier-readiness.ts, and only src/index.ts (the Worker entry) may reach it through studio.ts.
// Every other module in src/ and modules/ -- the render path, the config path, the preflight,
// orchestrator-env, video-finish-availability, the binding and its callers -- must not reach it,
// directly or transitively.

const ROOT = process.cwd();
const TARGET = "src/tier-readiness.ts";
const ALLOWED_REACHERS = new Set(["src/studio.ts", "src/index.ts"]);

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules") continue;
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...listTs(rel));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

const SPEC = /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function resolveSpec(from: string, spec: string, files: Map<string, string>): string | null {
  if (!spec.startsWith(".")) return null;
  const base = normalize(join(dirname(from), spec)).replace(/\.js$/, "");
  for (const cand of [base, base + ".ts", join(base, "index.ts")]) if (files.has(cand)) return cand;
  return null;
}

/** Files other than the allowed two whose transitive imports reach the target. */
function reachers(files: Map<string, string>): string[] {
  const edges = new Map<string, string[]>();
  for (const [f, src] of files) {
    const deps: string[] = [];
    for (const m of src.matchAll(SPEC)) {
      const r = resolveSpec(f, m[1] ?? m[2] ?? m[3], files);
      if (r) deps.push(r);
    }
    edges.set(f, deps);
  }
  const reaches = (start: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(edges.get(start) ?? [])];
    while (stack.length) {
      const n = stack.pop() as string;
      if (n === TARGET) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(edges.get(n) ?? []));
    }
    return false;
  };
  return [...files.keys()].filter((f) => f !== TARGET && reaches(f)).sort();
}

function realTree(): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of [...listTs("src"), ...listTs("modules")]) m.set(relative(ROOT, join(ROOT, f)), readFileSync(join(ROOT, f), "utf8"));
  return m;
}

describe("cf#887 import graph: nothing on the render or config path reaches tier-readiness", () => {
  it("in the real tree only the route table and the Worker entry reach it", () => {
    const files = realTree();
    expect(files.size, "the scan read the tree").toBeGreaterThan(50);
    const hit = reachers(files);
    // Positive control on the REAL tree: the instrument sees the one real import, so a zero below
    // is a reading and not a blind scanner.
    expect(hit).toEqual([...ALLOWED_REACHERS].sort());
  });

  it.each([
    ["a direct import in video-finish-availability.ts", "src/video-finish-availability.ts", 'import { hTierReadiness } from "./tier-readiness";\n'],
    ["a .js-suffixed import in orchestrator-env.ts", "src/orchestrator-env.ts", 'import { hTierReadiness } from "./tier-readiness.js";\n'],
    ["a dynamic import in door-duration-preflight.ts", "src/door-duration-preflight.ts", 'const m = await import("./tier-readiness");\n'],
    ["a transitive reach: render-door.ts importing the route table", "src/render-door.ts", 'import { API_ROUTES } from "./studio";\n'],
  ])("planted control: %s is caught", (_n, file, line) => {
    const files = realTree();
    expect(files.has(file), `${file} exists`).toBe(true);
    files.set(file, line + (files.get(file) as string));
    expect(reachers(files)).toContain(file);
  });

  it("hModules and the hooks_unavailable path never touch it; studio.ts does not re-export it", () => {
    const studio = readFileSync(join(ROOT, "src/studio.ts"), "utf8");
    expect(studio.match(/hTierReadiness/g)?.length, "one import plus one route row").toBe(2);
    const hModules = /const hModules: Handler = [\s\S]*?\n};\n/.exec(studio)?.[0] ?? "";
    expect(hModules.length, "found hModules").toBeGreaterThan(100);
    expect(hModules).not.toMatch(/readiness/i);
    expect(studio).not.toMatch(/export\s*\{[^}]*hTierReadiness/);
  });

  it("the module schedules nothing and writes no tier declaration", () => {
    const src = readFileSync(join(ROOT, TARGET), "utf8");
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/setInterval|scheduled|alarm|VIDEO_FINISH_TIER_STATE|\.put\(|\.prepare\(/);
  });
});
