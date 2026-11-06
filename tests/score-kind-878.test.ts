import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkManifest } from "@skyphusion-labs/vivijure-core/modules/conformance";
import { pickScoreModule } from "@skyphusion-labs/vivijure-core/modules/score-select";
import { SCORE_KINDS, type RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";
import musicGen from "../modules/music-gen/src/index";
import narrationGen from "../modules/narration-gen/src/index";
import beatSync from "../modules/beat-sync/src/index";

// vivijure-cf#878 (ruling A): every score module this repo ships declares what it produces, read from
// the manifest each worker actually serves, and the host picks by that declaration.

const WORKERS = { "music-gen": musicGen, "narration-gen": narrationGen, "beat-sync": beatSync } as const;
const EXPECTED: Record<keyof typeof WORKERS, string> = { "music-gen": "music", "narration-gen": "narration", "beat-sync": "beat" };

async function served(name: keyof typeof WORKERS): Promise<Record<string, unknown>> {
  const w = WORKERS[name] as unknown as { fetch(r: Request, env?: unknown, ctx?: unknown): Promise<Response> };
  const res = await w.fetch(new Request("https://module/module.json"), {}, { waitUntil() {}, passThroughOnException() {} });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("the shipped score modules declare their kind (vivijure-cf#878)", () => {
  for (const name of Object.keys(WORKERS) as (keyof typeof WORKERS)[]) {
    it(`${name} serves score_kind "${EXPECTED[name]}" and passes core conformance`, async () => {
      const m = await served(name);
      expect(m.hooks).toEqual(["score"]);
      expect(m.score_kind).toBe(EXPECTED[name]);
      const check = checkManifest(m).find((c) => c.name === "score-kind");
      expect(check?.pass).toBe(true);
    });
  }

  it("the host picks each kind's own module from the served manifests", async () => {
    const mods = await Promise.all((Object.keys(WORKERS) as (keyof typeof WORKERS)[]).map(async (n) =>
      ({ ...(await served(n)), binding: `MODULE_${n}` }) as unknown as RegisteredModule));
    for (const kind of SCORE_KINDS) {
      const p = pickScoreModule(mods, kind);
      expect(p.ok && p.module.name).toBe(Object.entries(EXPECTED).find(([, k]) => k === kind)![0]);
    }
  });

  it("each vendored contract carries exactly core's SCORE_KINDS", () => {
    for (const name of Object.keys(WORKERS)) {
      const src = readFileSync(join(process.cwd(), "modules", name, "src", "contract.ts"), "utf8");
      const m = /score_kind\?: ((?:"[a-z]+"(?: \| )?)+);/.exec(src);
      expect(m, `${name} contract.ts declares score_kind`).not.toBeNull();
      const vendored = [...m![1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
      expect(vendored).toEqual([...SCORE_KINDS]);
    }
  });
});
