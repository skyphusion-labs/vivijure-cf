import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TOOLS, runTool } from "@skyphusion-labs/vivijure-mcp/mcp-tools";
import type { McpEnv } from "@skyphusion-labs/vivijure-mcp/mcp-env";

// cf#317 -- the MCP parity DENOMINATOR, measured and guarded against drift.
//
// The issue that filed this listed the MCP's coverage as a paragraph. A paragraph is a claim; this
// file is the measurement. Everything here is DERIVED at test time from two artifacts:
//
//   * the studio route table in src/index.ts (what a caller can ask the studio to do), and
//   * the TOOL CATALOG of the installed @skyphusion-labs/vivijure-mcp package -- the same code the
//     deployed MCP Worker runs, not a re-typed list of tool names.
//
// The numbers in docs/mcp-parity.md are asserted against that derivation, so the doc cannot quietly
// go stale: add a route or a tool and this test fails until the published denominator is updated.
// Same discipline as docs/module-readiness-coverage.md (cf#295/#313), for the same reason -- a
// surface that reports on a subset without saying so is the defect.

// Paths are resolved from the vitest root (the repo root), not from import.meta.url: the workers-types
// URL in scope here is not node's URL, and readFileSync will not take it.
const SRC = readFileSync(`${process.cwd()}/src/index.ts`, "utf8");

const PANEL_FILES = [
  "app.js", "cast.js", "planner-cast.js", "planner-render.js", "planner-projects.js",
  "planner-history-list.js", "planner-history-row.js", "planner-plan.js", "planner-refine.js",
  "planner-preflight.js", "planner-bundle.js", "planner-audio.js", "planner-scenes.js",
  "planner-registry.js", "planner-render-config.js", "planner-restore.js", "planner-init.js",
  "planner-stepper.js", "settings.js", "modules.html", "cast.html", "planner.html", "settings.html",
  "model-catalog.js", "studio-chrome.js", "topbar.js", "cast-select.js", "hook-availability.js",
  "lora-preflight.js", "render-eta.js", "finish-degrade.js", "readonly-gate.js", "auth-token.js",
  "demo-steer.js", "abuse-link.js", "planner-fieldhelp.js",
];
const PANEL = PANEL_FILES.map((f) => {
  try {
    return readFileSync(`${process.cwd()}/public/${f}`, "utf8");
  } catch {
    return "";
  }
}).join("\n");

interface Route {
  method: string;
  pattern: string;
}

function studioRoutes(): Route[] {
  const start = SRC.indexOf("export const API_ROUTES: Route[] = [");
  expect(start, "API_ROUTES table not found in src/index.ts").toBeGreaterThan(-1);
  const end = SRC.indexOf("\n];", start);
  expect(end, "API_ROUTES terminator not found").toBeGreaterThan(start);
  const block = SRC.slice(start, end);
  const out: Route[] = [];
  for (const m of block.matchAll(/\{\s*method:\s*"([A-Z]+)",\s*pattern:\s*"([^"]+)"/g)) {
    out.push({ method: m[1], pattern: m[2] });
  }
  // GET /api/modules is dispatched in routeRequest BEFORE the table (it opts into a 60s isolate
  // cache), so it is absent from API_ROUTES while being one of the most-used routes on the surface.
  // Counting the table alone would undercount by exactly this one, silently.
  out.push({ method: "GET", pattern: "/api/modules" });
  return out;
}

// Build() needs its required args; supply a shaped placeholder so the call it emits can be read.
function placeholderArgs(tool: (typeof TOOLS)[number]): Record<string, unknown> {
  const schema = tool.inputSchema as {
    required?: string[];
    properties?: Record<string, { type?: unknown }>;
  };
  const args: Record<string, unknown> = {};
  for (const k of schema.required ?? []) {
    const raw = schema.properties?.[k]?.type;
    const ty = Array.isArray(raw) ? raw[0] : raw;
    if (ty === "object") args[k] = {};
    else if (ty === "array") args[k] = ["x"];
    else if (ty === "number") args[k] = 1;
    else if (k === "method") args[k] = "GET";
    else if (k === "path") args[k] = "/api/probe";
    else args[k] = "PLACEHOLDER";
  }
  return args;
}

// A tool's emitted path carries the placeholder where the route table carries ":id". Normalize so the
// two can be compared. Only whole segments are rewritten, so a literal segment is never mangled.
const toPattern = (p: string) => p.replace(/\/PLACEHOLDER(?=\/|$)/g, "/:id");

function curatedCoverage(): Map<string, string> {
  const cov = new Map<string, string>();
  for (const t of TOOLS) {
    if (t.name === "studio_request") continue; // the escape hatch reaches everything; counted apart
    const call = t.build(placeholderArgs(t));
    cov.set(`${call.method} ${toPattern(call.path)}`, t.name);
  }
  return cov;
}

// The panel builds most URLs by concatenation ("/api/cast/" + id + "/train-lora") and some as template
// literals, so a route's literal segments are matched in order across a bounded gap. The gap refuses to
// span another "/api/" so a match can never be stitched together from two different call sites.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function panelReaches(pattern: string): boolean {
  const parts = pattern.split(/\/(?::[A-Za-z]+|\*[A-Za-z]+)(?=\/|$)/);
  return new RegExp(parts.map(esc).join("(?:(?!/api/)[^\\n]){0,60}")).test(PANEL);
}

describe("cf#317 parity measurement -- the matchers themselves", () => {
  // A matcher that agrees with expectation is the one nobody checks. Both directions, explicitly.
  it("panel matcher: positive control matches routes the panel demonstrably calls", () => {
    expect(panelReaches("/api/storyboard/plan")).toBe(true);
    expect(panelReaches("/api/cast/:id/train-lora")).toBe(true); // built by concatenation
  });

  it("panel matcher: negative control does NOT match routes the panel never calls", () => {
    expect(panelReaches("/api/definitely-not-a-real-route")).toBe(false);
    expect(panelReaches("/api/storage/reconcile")).toBe(false);
  });

  it("route parser returns a plausible table, not an empty one", () => {
    // An empty parse would make every coverage number 0-of-0 and read as "nothing to cover".
    expect(studioRoutes().length).toBeGreaterThan(50);
  });

  it("tool catalog is the installed package, and every tool builds a studio call", () => {
    expect(TOOLS.length).toBeGreaterThan(10);
    for (const t of TOOLS) {
      const call = t.build(placeholderArgs(t));
      expect(call.path, `${t.name} built no path`).toMatch(/^\//);
    }
  });
});

// These are the numbers docs/mcp-parity.md publishes. They are asserted, not described, so the doc and
// the code cannot drift apart silently. When one fails, the fix is to RE-MEASURE and update the doc,
// never to relax the assertion.
const PUBLISHED = {
  routes: 85, // studio API route entries (method+pattern), incl. the pre-table GET /api/modules
  tools: 19, // MCP tools: curated + the studio_request escape hatch
  curatedCovered: 18, // route entries reached by a CURATED tool
  panelReachable: 70, // route entries the studio panel calls (the human surface)
};

describe("cf#317 published parity denominator (docs/mcp-parity.md)", () => {
  it("route entry count matches the published number", () => {
    expect(studioRoutes().length).toBe(PUBLISHED.routes);
  });

  it("MCP tool count matches the published number", () => {
    expect(TOOLS.length).toBe(PUBLISHED.tools);
  });

  it("curated-tool coverage matches the published number", () => {
    const cov = curatedCoverage();
    const covered = studioRoutes().filter((r) => cov.has(`${r.method} ${r.pattern}`));
    expect(covered.length).toBe(PUBLISHED.curatedCovered);
  });

  it("panel-reachable count matches the published number", () => {
    expect(studioRoutes().filter((r) => panelReaches(r.pattern)).length).toBe(PUBLISHED.panelReachable);
  });

  it("every curated tool maps onto a route that actually exists", () => {
    // A tool pointing at a route that was renamed or deleted is a dead tool that still lists itself in
    // the catalog: the agent-facing version of a stale doc.
    const known = new Set(studioRoutes().map((r) => `${r.method} ${r.pattern}`));
    const orphans = [...curatedCoverage().entries()]
      .filter(([k]) => !known.has(k))
      .map(([k, v]) => `${v} -> ${k}`);
    expect(orphans).toEqual([]);
  });
});

// Action parity through `studio_request` is essentially complete: it reaches any route in the contract.
// The hole is a CLASS, not a list -- every route whose response is BYTES, because runTool summarizes
// binary rather than returning it. That class is the whole of "the agent cannot see what it made", and
// it is asserted here against the SHIPPED runTool rather than reasoned about.

const BINARY_ROUTES = [
  "GET /api/artifact/*key",
  "HEAD /api/artifact/*key",
  "GET /api/cast/export/:id",
  "POST /api/cast/export/:id",
];

const MCP_ENV = { STUDIO_URL: "https://studio.example", STUDIO_API_TOKEN: "test-token" } as McpEnv;

async function withStubbedFetch(res: () => Response, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => res()) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

describe("cf#317 the byte-returning class the MCP cannot carry", () => {
  it("the byte-returning routes named in the doc all exist in the route table", () => {
    const known = new Set(studioRoutes().map((r) => `${r.method} ${r.pattern}`));
    for (const r of BINARY_ROUTES) expect(known.has(r), `${r} is not a real route`).toBe(true);
  });

  it("runTool refuses to return video bytes (this is the film Conrad wants to watch)", async () => {
    await withStubbedFetch(
      () =>
        new Response(new Uint8Array([0, 0, 0, 24]), {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": "3811331" },
        }),
      async () => {
        const res = await runTool(MCP_ENV, {
          method: "GET",
          path: "/api/artifact/renders/f/film.mp4",
        });
        expect(res.content[0].text).toContain("not inlined");
        expect(res.content.every((c) => c.type === "text")).toBe(true);
      },
    );
  });

  it("runTool refuses image bytes too, even though MCP itself can carry an image", async () => {
    // The sharper half. MCP has an image content type; the studio has the bytes; the refusal is OURS.
    // An agent cannot look at a keyframe, a portrait, or a generated still.
    await withStubbedFetch(
      () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "2048" },
        }),
      async () => {
        const res = await runTool(MCP_ENV, { method: "GET", path: "/api/artifact/cast/p.png" });
        expect(res.content[0].text).toContain("not inlined");
        expect(res.content.every((c) => c.type === "text")).toBe(true);
      },
    );
  });

  it("positive control: runTool DOES return a JSON reply through the same path", async () => {
    // Without this, the two refusals above would pass identically if runTool were simply broken.
    await withStubbedFetch(
      () =>
        new Response(JSON.stringify({ ok: true, film_key: "renders/f/film.mp4" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      async () => {
        const res = await runTool(MCP_ENV, { method: "GET", path: "/api/render/film/x" });
        expect(res.isError).toBe(false);
        expect(res.content[0].text).toContain("film_key");
      },
    );
  });
});
