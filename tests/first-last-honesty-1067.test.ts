// cf#1067 part 2: `usage.first_last` is published, and the studio acts on it. Core keeps the end
// frame on a shot only when the door declares it, and the Make a video page grades a door's face
// hold on it. Nothing checked that the door then SENDS the end frame. A door that declared it and
// dropped the frame would lose it with no word, and a door that sent it without declaring it would
// never receive one, because core strips it first.
//
// So this runs each door's REAL param builder with an end frame on the input, reads the door's REAL
// manifest from its own worker, and requires the two to agree. Every motion door in modules/ is
// accounted for: a door with no param builder must be named in NO_BUILDER, so a new door cannot
// slip past by having a different shape.

import { describe, expect, it } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

type Worker = { fetch(request: Request, env: never, ctx: never): Promise<Response> };
type Params = { buildParams?: (...a: unknown[]) => unknown; normalizeConfig?: (raw: Record<string, unknown>) => unknown };

// These doors post the whole input to their own backend and have no param builder to run. All of
// them declare no first_last, so core strips the end frame before they see it.
const NO_BUILDER = new Set(["alibaba-wan", "alibaba-wan-lora", "infinitetalk", "local-gpu", "minimax-hailuo", "own-gpu"]);
const END = "https://end.example/END_FRAME_SENTINEL.png";
const root = join(__dirname, "..", "modules");

async function motionDoors() {
  const out: { name: string; firstLast: boolean; params: Params | null }[] = [];
  for (const name of readdirSync(root).sort()) {
    const idx = join(root, name, "src", "index.ts");
    if (!existsSync(idx)) continue;
    const worker = (await import(idx)).default as Worker;
    const res = await worker.fetch(new Request("https://m.example/module.json"), {} as never, {} as never);
    if (!res.ok) continue;
    const m = (await res.json()) as { hooks?: string[]; usage?: { first_last?: boolean } };
    if (!m.hooks?.includes("motion.backend")) continue;
    const pp = join(root, name, "src", "params.ts");
    out.push({ name, firstLast: m.usage?.first_last === true, params: existsSync(pp) ? ((await import(pp)) as Params) : null });
  }
  return out;
}

describe("cf#1067: a door declares usage.first_last exactly when it sends the end frame", () => {
  it("every door's builder agrees with its manifest", async () => {
    const doors = await motionDoors();
    // The denominator. A loader that found nothing would pass every check below.
    expect(doors.length).toBeGreaterThanOrEqual(16);
    const checked: string[] = [];
    const disagree: string[] = [];
    for (const d of doors) {
      if (!d.params?.buildParams) {
        expect(NO_BUILDER.has(d.name), `${d.name} has no param builder and is not named in NO_BUILDER`).toBe(true);
        expect(d.firstLast, `${d.name} declares first_last but has no builder this test can check`).toBe(false);
        continue;
      }
      const config = d.params.normalizeConfig ? d.params.normalizeConfig({}) : {};
      const input = { shot_id: "s1", prompt: "p", seconds: 5, keyframe_url: "https://start.example/k.png", last_keyframe_url: END, last_keyframe_key: "k/end.png" };
      const built = d.params.buildParams(input, config, "data:image/png;base64,AA");
      const sends = JSON.stringify(built).includes("END_FRAME_SENTINEL");
      if (sends !== d.firstLast) disagree.push(`${d.name}: declares first_last=${d.firstLast}, sends end frame=${sends}`);
      checked.push(d.name);
    }
    expect(disagree).toEqual([]);
    // Every door in NO_BUILDER must still exist and still lack a builder, or the list has gone stale.
    for (const n of NO_BUILDER) expect(doors.find((d) => d.name === n && !d.params?.buildParams), n).toBeTruthy();
    expect(checked.length + NO_BUILDER.size).toBe(doors.length);
  });
});
