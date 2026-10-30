// cf#1055: a silent door's card must say what submit does. The cards promised "Speaking is the Cast
// voice, muxed" while prepareSpokenClip refused the board, so the planner sold a render the gate
// would not start. The gate is the contract. Copy follows it.
//
// The population is modules/ on disk, not a list here: a list cannot notice a new door.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import { doorCanSpeakLines, isSilentCatalogDoor, prepareSpokenClip } from "../src/motion-scatter";

const ROOT = join(__dirname, "..");
const MUX_PROMISE = /muxed|if they speak|add a cast voice|speaking is the cast voice/i;

/** The motion doors on disk, with the source file that carries each manifest. */
function motionDoorSources(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const name of readdirSync(join(ROOT, "modules"))) {
    if (name.startsWith("_")) continue;
    for (const file of ["index.ts", "manifest.ts"]) {
      const p = join(ROOT, "modules", name, "src", file);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      if (/hooks:\s*\[[^\]]*"motion\.backend"/.test(text)) out.push({ name, text });
    }
  }
  return out;
}

function silentDoor(name: string): RegisteredModule {
  return {
    name, version: "0.1.0", api: "vivijure-module/2", hooks: ["motion.backend"], ui: { order: 10 },
    usage: { native_audio: false, voice: "cast_tts", scatter_native_audio: false, min_seconds: 3, max_seconds: 10 },
  } as unknown as RegisteredModule;
}

describe("cf#1055 silent door copy agrees with the spoken-line gate", () => {
  it("finds the motion doors, so an empty scan cannot pass", () => {
    const names = motionDoorSources().map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["minimax-hailuo", "cf-hailuo", "cf-hh1-r2v", "local-gpu", "own-gpu"]));
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it("the gate refuses a spoken line on a silent door", () => {
    const door = silentDoor("minimax-hailuo");
    expect(isSilentCatalogDoor(door)).toBe(true);
    expect(doorCanSpeakLines(door)).toBe(false);
    const res = prepareSpokenClip([door], door, {}, undefined, true);
    expect(res.ok).toBe(false);
  });

  it("no motion door's manifest promises a muxed voice", () => {
    const offenders = motionDoorSources().flatMap(({ name, text }) =>
      text.split("\n")
        .filter((l) => !l.trim().startsWith("//") && MUX_PROMISE.test(l))
        .map((l) => `${name}: ${l.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it.each(["docs/motion-door-limits.md", "docs/opt-in-tiers.md", "modules/dialogue-gen/README.md", "modules/chatterbox/README.md"])(
    "%s does not promise a muxed voice on a silent door",
    (rel) => {
      expect(readFileSync(join(ROOT, rel), "utf8")).not.toMatch(/Cast voice (is )?muxed|Cast voice MUXED/i);
    },
  );
});
