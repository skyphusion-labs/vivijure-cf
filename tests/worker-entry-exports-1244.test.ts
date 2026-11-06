// cf#1244: a Worker entry may export only what the runtime can serve.
//
// workerd reads EVERY export of a Worker's main module as an entrypoint. A class becomes a class
// entrypoint (WorkerEntrypoint, DurableObject, WorkflowEntrypoint, Container); an object becomes an
// ExportedHandler. Anything else refuses the whole worker at startup:
//
//   Uncaught TypeError: Incorrect type for map entry 'FILM_DOC_GRACE_MS': the provided value is not
//   of type 'function or ExportedHandler'.
//
// That is what stopped the module-bound `wrangler dev` (.dev-modbound/dev-modbound.sh): the
// cloud-keyframe entry exported a number. typecheck cannot see this and no unit test imported the
// entry as the runtime does, so it shipped.
//
// This test finds every Worker entry the repo deploys by reading each wrangler config's `main`
// (never a hand list, so a new module is covered the day it lands), imports it, and applies two rules.
//
//   1. HARD (no exceptions): every export is a function or a non-null object, and an object that
//      carries a handler key carries a function there. This is the rule workerd enforces; a breach
//      is a worker that does not start.
//   2. CONTRACT (ratchet, in-tree entries): a named export is a class. Helpers, constants and manifests belong in a
//      leaf module the entry imports. The exports that predate this test are listed in BASELINE by
//      entry and name. The list may only shrink: a new non-class export fails, and a listed name
//      that is gone fails too, so the list cannot rot into a blanket pass.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ExportedHandler keys workerd reads off an object export. A non-function value under one of these
// refuses the worker the same way a bad export type does.
const HANDLER_KEYS = [
  "fetch", "tail", "trace", "tailStream", "scheduled", "alarm", "test", "queue", "email", "connect",
  "webSocketMessage", "webSocketClose", "webSocketError",
];

// Non-class named exports that predate cf#1244, by entry (repo-relative main) and name. Remove a line
// when its export moves to a leaf module. Never add one: move the export instead.
const BASELINE: Record<string, string[]> = {
  "src/index.ts": [
    "API_ROUTES", "ARTIFACT_PREFIXES", "clampArtifactUrlTtl", "runSweepPass", "safeArtifactContentType",
  ],
};

/** Every wrangler config in the tree (committed `.toml` and `.toml.example`), never node_modules. */
function wranglerConfigs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === ".wrangler") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) wranglerConfigs(p, out);
    else if (/^wrangler(\.[a-z0-9-]+)?\.toml(\.example)?$/.test(name)) out.push(p);
  }
  return out;
}

/** The top-level `main` of a wrangler TOML: the first `main = "..."` before any table header. */
function topLevelMain(toml: string): string | null {
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) return null;
    const m = /^main\s*=\s*"([^"]+)"/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** The generated dev configs under .dev-modbound/mods are copies of committed ones; skip them. */
const entries = [
  ...new Set(
    wranglerConfigs(ROOT)
      .filter((c) => !relative(ROOT, c).startsWith(".dev-modbound/"))
      .flatMap((c) => {
        const main = topLevelMain(readFileSync(c, "utf8"));
        return main ? [relative(ROOT, resolve(dirname(c), main))] : [];
      }),
  ),
].sort();

const isClass = (v: unknown): boolean =>
  typeof v === "function" && /^class[\s{]/.test(Function.prototype.toString.call(v));

/** The workerd rule. Returns why the value would refuse the worker, or null when it would load. */
export function workerdRefusal(name: string, v: unknown): string | null {
  if (typeof v === "function") return null;
  if (typeof v !== "object" || v === null) {
    return `export '${name}' is ${v === null ? "null" : typeof v}, not a function or ExportedHandler`;
  }
  for (const k of HANDLER_KEYS) {
    const h = (v as Record<string, unknown>)[k];
    if (h !== undefined && typeof h !== "function") {
      return `export '${name}' has handler '${k}' of type ${typeof h}, not a function`;
    }
  }
  return null;
}

describe("cf#1244: every Worker entry exports only what workerd can serve", () => {
  it("finds the entries from the wrangler configs, not a hand list", () => {
    // A walk that found nothing would pass every rule below. 33 modules + 5 containers + core +
    // tail + mcp at the time of writing; the floor sits below that so adding a module never breaks it.
    expect(entries.length).toBeGreaterThanOrEqual(40);
    expect(entries).toContain("modules/cloud-keyframe/src/index.ts");
    expect(entries).toContain("src/index.ts");
    for (const e of entries) expect(existsSync(join(ROOT, e)), e).toBe(true);
  });

  it("the workerd rule refuses a number and accepts a class, a handler object and a function", () => {
    expect(workerdRefusal("N", 360000)).toMatch(/is number/);
    expect(workerdRefusal("S", "x")).toMatch(/is string/);
    expect(workerdRefusal("Z", null)).toMatch(/is null/);
    expect(workerdRefusal("H", { fetch: 1 })).toMatch(/handler 'fetch'/);
    expect(workerdRefusal("C", class {})).toBeNull();
    expect(workerdRefusal("default", { fetch() {} })).toBeNull();
  });

  it("the BASELINE names only entries this test found", () => {
    for (const e of Object.keys(BASELINE)) expect(entries, e).toContain(e);
  });

  for (const entry of entries) {
    it(`${entry}`, async () => {
      const mod = (await import(pathToFileURL(join(ROOT, entry)).href)) as Record<string, unknown>;
      const names = Object.keys(mod).sort();
      expect(names, "an entry with no exports is not a Worker").not.toHaveLength(0);

      const refusals = names.map((n) => workerdRefusal(n, mod[n])).filter((r): r is string => r !== null);
      expect(refusals, "workerd refuses this worker at startup").toEqual([]);

      // A published package (the MCP worker) is held to the workerd rule only: its export shape is
      // that package's contract, changed in its own repo, not here.
      if (entry.startsWith("node_modules/")) return;

      const allowed = BASELINE[entry] ?? [];
      const nonClass = names.filter((n) => n !== "default" && !isClass(mod[n]));
      expect(
        nonClass.filter((n) => !allowed.includes(n)),
        "a named export of a Worker entry must be a class; move it to a leaf module",
      ).toEqual([]);
      expect(
        allowed.filter((n) => !nonClass.includes(n)),
        "BASELINE lists an export that is gone or now a class; delete the line",
      ).toEqual([]);
    });
  }
});
