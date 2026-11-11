/// <reference types="node" />
// vivijure-cf#930: a lined shot whose film door's clip floor would leave the speaker mouthing silence
// after the line. Core (1.47.0) moves it to an offered door for that one clip, or records the tail;
// this repo builds the offer (src/door-fit-offer.ts); the panel half is tests/door-fit-panel-930.test.ts.
// Conrad's ruling 2026-11-11: a per-shot door applies to that one clip only, and the film's door stays
// the default for every other shot.
import { describe, expect, it } from "vitest";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import { DOOR_FIT_FOR_EXPLICIT_FILM_DOOR, doorFitOffer } from "../src/door-fit-offer";

function motion(name: string, usage: Record<string, unknown>, order: number, locality = "cloud", schema: Record<string, unknown> = {}): RegisteredModule {
  return {
    name, binding: `MODULE_${name.toUpperCase().replace(/-/g, "_")}`, version: "1.0.0", api: "vivijure-module/2",
    hooks: ["motion.backend"], usage, config_schema: schema, ui: { order, section: "motion", locality },
  } as unknown as RegisteredModule;
}
const base = { voice: "cast_tts", scatter_native_audio: false, min_seconds: 2, max_seconds: 15 };
const wan = motion("alibaba-wan", { ...base, native_audio: true, driving_audio: true, min_seconds: 5, duration_steps: [5, 10, 15] }, 70);
const talk = motion("infinitetalk", { ...base, native_audio: false, driving_audio: true }, 15, "cloud", {
  generate_audio: { type: "bool", default: true },
});
const hailuo = motion("cf-hailuo", { ...base, native_audio: false, driving_audio: false }, 30);
const localTalk = motion("local-talk", { ...base, native_audio: false, driving_audio: true }, 5, "local");
const MODULES = [wan, talk, hailuo, localTalk];

describe("the door-fit offer (cf#930)", () => {
  it("a spoken film on a driven door the studio picked offers the other driven doors of its locality, prepared", () => {
    const offer = doorFitOffer(MODULES, "alibaba-wan", { spoken: true, explicit: false });
    expect(offer.door_fit).toEqual(["infinitetalk"]);
    // Prepared as the film path prepares a driving-only door for spoken lines: no native audio.
    expect(offer.motion_configs).toEqual({ infinitetalk: { generate_audio: false } });
  });

  it("offers nothing to a silent film, a silent film door, or a missing door", () => {
    expect(doorFitOffer(MODULES, "alibaba-wan", { spoken: false, explicit: false })).toEqual({});
    expect(doorFitOffer(MODULES, "cf-hailuo", { spoken: true, explicit: false })).toEqual({});
    expect(doorFitOffer(MODULES, undefined, { spoken: true, explicit: false })).toEqual({});
  });

  it("a film door the caller named is offered too (Conrad's ruling, 2026-11-11: B)", () => {
    expect(DOOR_FIT_FOR_EXPLICIT_FILM_DOOR).toBe(true);
    expect(doorFitOffer(MODULES, "alibaba-wan", { spoken: true, explicit: true }).door_fit).toEqual(["infinitetalk"]);
  });
});
