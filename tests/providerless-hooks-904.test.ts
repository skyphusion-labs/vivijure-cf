// cf#904: a catalog hook no module provides is reported in host.hooks_unavailable, and the report
// clears itself when something serving it is installed.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { hookCatalog } from "@skyphusion-labs/vivijure-core/modules/registry";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import worker from "../src/index";
import { PROVIDERLESS_HOOKS, PROVIDERLESS_HOOK_REASON, providerlessHooksUnavailable } from "../src/providerless-hooks";

const MODULES_DIR = join(import.meta.dirname, "..", "modules");

/** Every hook a first-party module declares, read from the manifest source (`hooks: [...]`). */
function declaredHooks(): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const m of readdirSync(MODULES_DIR).filter((d) => d !== "_shared")) {
    for (const f of ["index.ts", "manifest.ts"]) {
      const p = join(MODULES_DIR, m, "src", f);
      if (!existsSync(p)) continue;
      for (const match of readFileSync(p, "utf8").matchAll(/^\s*hooks:\s*\[([^\]]*)\]/gm)) {
        for (const h of match[1].matchAll(/"([^"]+)"/g)) by.set(h[1], [...(by.get(h[1]) ?? []), m]);
      }
    }
  }
  return by;
}

describe("cf#904: the providerless list is held equal to the tree", () => {
  const declared = declaredHooks();
  const catalog = hookCatalog().map((h) => h.name);

  it("CONTROL: the manifest scan finds real providers", () => {
    expect(declared.get("motion.backend")?.length ?? 0).toBeGreaterThan(5);
    expect(declared.get("dialogue")?.length ?? 0).toBeGreaterThan(0);
    expect(declared.get("finish")).toContain("finish-upscale");
  });

  it("PROVIDERLESS_HOOKS is exactly the catalog hooks no first-party module declares", () => {
    const providerless = catalog.filter((h) => !declared.has(h)).sort();
    expect([...PROVIDERLESS_HOOKS].sort()).toEqual(providerless);
  });

  it("speech is still in the catalog: the hook is not retired, only reported unavailable", () => {
    expect(catalog).toContain("speech");
  });
});

describe("cf#904: derived from what is installed", () => {
  const speechModule = { name: "third-party-speech", hooks: ["speech"] } as unknown as RegisteredModule;

  it("nothing installed serves speech: reported, with the reason", () => {
    expect(providerlessHooksUnavailable([])).toEqual({ speech: PROVIDERLESS_HOOK_REASON.speech });
  });

  it("a module serving speech is installed: the key is gone", () => {
    expect(providerlessHooksUnavailable([speechModule])).toEqual({});
  });
});

describe("cf#904: GET /api/modules says so", () => {
  it("host.hooks_unavailable.speech carries the reason, and the catalog still lists speech", async () => {
    const env = {
      ALLOW_UNAUTHENTICATED: "true",
      ASSETS: { fetch: async () => new Response("asset") },
    } as unknown as Parameters<typeof worker.fetch>[1];
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as Parameters<typeof worker.fetch>[2];
    const res = await worker.fetch(new Request("https://studio.example/api/modules"), env, ctx);
    const body = (await res.json()) as {
      hooks: Record<string, string[]>;
      catalog: { name: string }[];
      host?: { hooks_unavailable?: Record<string, string> };
    };
    // CONTROL: this deploy serves nothing for speech, which is the condition under test.
    expect(body.hooks.speech).toBeUndefined();
    expect(body.catalog.map((h) => h.name)).toContain("speech");
    expect(body.host?.hooks_unavailable?.speech).toBe(PROVIDERLESS_HOOK_REASON.speech);
  });
});
