// POST /api/modules/install on a studio provisioned with TENANT_MODULE_PREFIX accepts only a script
// under that prefix, and refuses any other BEFORE the dispatch namespace is touched. Without the var
// (self-host, one studio per namespace) any resident script installs, as before. Driven through the
// real worker router with the operator token, the way the provisioning plane calls it.
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";

const TOKEN = "op-token-for-tests";
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const MANIFEST = { name: "pe-cloud", version: "1.0.0", api: MODULE_API, hooks: ["plan.enhance"] };
function fakeModule() {
  return {
    async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/module.json")) return new Response(JSON.stringify(MANIFEST), { status: 200 });
      if (url.endsWith("/invoke")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { hook: string };
        if (body.hook === "not.a.real.hook") return new Response(JSON.stringify({ ok: false, error: "unknown hook" }), { status: 200 });
        return new Response(JSON.stringify({ ok: true, output: { storyboard: { scenes: [{ prompt: "x" }] } } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

function harness(prefix?: string) {
  const touched: string[] = [];
  const writes: string[] = [];
  const scripts: Record<string, ReturnType<typeof fakeModule>> = {
    "ten-aaaa-keyframe": fakeModule(),
    "ten-bbbb-keyframe": fakeModule(),
    "plain-keyframe": fakeModule(),
  };
  const DB = {
    prepare(sql: string) {
      const stmt = {
        bind: () => stmt,
        async run() { writes.push(sql); return { meta: { changes: 1 } }; },
        async all() { return { results: [] }; },
        async first() { return null; },
      };
      return stmt;
    },
    async batch() { return []; },
  };
  const env = {
    AUTH_MODE: "token",
    STUDIO_API_TOKEN: TOKEN,
    ASSETS: { fetch: async () => new Response("ASSET") },
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    DB,
    MODULE_DISPATCH: {
      get(script: string) {
        touched.push(script);
        const f = scripts[script];
        if (!f) throw new Error(`script ${script} not found in namespace`);
        return f;
      },
    },
    ...(prefix === undefined ? {} : { TENANT_MODULE_PREFIX: prefix }),
  };
  const install = (script_name: string) => worker.fetch(new Request("https://studio.example/api/modules/install", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ script_name }),
  }), env as never, ctx);
  return { install, touched, writes };
}

const rowWrites = (w: string[]) => w.filter((s) => /INSERT INTO installed_modules/.test(s)).length;

describe("module install stays inside this studio's own scripts", () => {
  it("CONTROL: the studio's own script installs (201, row written)", async () => {
    const h = harness("ten-aaaa-");
    const res = await h.install("ten-aaaa-keyframe");
    expect(res.status).toBe(201);
    expect(h.touched).toEqual(["ten-aaaa-keyframe"]);
    expect(rowWrites(h.writes)).toBe(1);
  });

  for (const script of ["ten-bbbb-keyframe", "plain-keyframe", "ten-aaaa", "xten-aaaa-keyframe"]) {
    it(`refuses ${script} with 403, never touches the namespace, writes no row`, async () => {
      const h = harness("ten-aaaa-");
      const res = await h.install(script);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error?: string }).error).toMatch(/not one of this studio's module scripts/);
      expect(h.touched).toEqual([]);
      expect(rowWrites(h.writes)).toBe(0);
    });
  }

  it("with no prefix set (self-host), any resident script installs as before", async () => {
    const h = harness();
    expect((await h.install("ten-bbbb-keyframe")).status).toBe(201);
    expect((await harness().install("plain-keyframe")).status).toBe(201);
  });

  it("an empty prefix is treated as unset", async () => {
    expect((await harness("  ").install("plain-keyframe")).status).toBe(201);
  });
});
