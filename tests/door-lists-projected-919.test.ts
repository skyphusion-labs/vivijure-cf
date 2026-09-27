// cf#919: the two hardcoded door lists. Both told a hosted filmmaker to pick InfiniteTalk, which no
// hosted tenant can install, so the product surface named a door that is not in the picker.
//
// These tests exist to be able to go RED. The failing case that motivated them: the refusal message
// was a string literal naming seven doors, so NO module set could change it -- there was no reading
// in which it could be wrong, which is why it stayed wrong. Every test below is written so that a
// re-hardcoded list fails it: the assertions are about doors ABSENT from the installed set, not only
// about the ones present.
import { describe, expect, it } from "vitest";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import { spokenLinesRefusalMessage, talkingDoorLabels } from "../src/motion-scatter";
import { TALKING_VOICE_HONOR, talkingVoiceHonorFor } from "../src/cast-voice-sample";

function door(
  name: string,
  o: { talks?: boolean; driving?: boolean; label?: string; order?: number; hook?: string } = {},
): RegisteredModule {
  return {
    name,
    version: "0.1.0",
    api: MODULE_API,
    hooks: [o.hook ?? "motion.backend"],
    ...(o.label ? { provides: [{ id: name, label: o.label }] } : {}),
    ui: { order: o.order ?? 10 },
    // A FULL MotionUsageDecl: parseMotionUsage (core/motion-usage.js) rejects a partial one and
    // discovery then drops the module, so a partial stub is a module production cannot produce.
    usage: { native_audio: !!o.talks, voice: "cast_tts", scatter_native_audio: false, min_seconds: 4, max_seconds: 10, driving_audio: !!o.driving },
  } as unknown as RegisteredModule;
}

describe("cf#919 talkingDoorLabels: the remedy is projected from the installed module set", () => {
  it("names the installed talking doors and nothing else", () => {
    const labels = talkingDoorLabels([
      door("seedance", { talks: true, order: 5 }),
      door("look-only", { order: 6 }),
      door("alibaba-wan", { driving: true, order: 7 }),
    ]);
    expect(labels).toEqual(["seedance", "alibaba-wan"]);
    // The door that cannot speak is absent. This is the half that a hardcoded list passes by
    // accident, so the next assertion is the load-bearing one.
    expect(labels).not.toContain("look-only");
  });

  it("does NOT name a talking door that is not installed", () => {
    // infinitetalk is a real talking door and cannot be installed on a hosted tenant. A projection
    // omits it here; any list that carries it fails.
    const labels = talkingDoorLabels([door("seedance", { talks: true })]);
    expect(labels).toEqual(["seedance"]);
    expect(labels).not.toContain("infinitetalk");
  });

  it("prefers the module display label (provides[0].label) over the bare name", () => {
    expect(talkingDoorLabels([door("seedance", { talks: true, label: "Seedance 1.5 (RunPod)" })]))
      .toEqual(["Seedance 1.5 (RunPod)"]);
  });

  it("ignores a talking module that does not serve motion.backend", () => {
    expect(talkingDoorLabels([door("chatterbox", { talks: true, hook: "speech" })])).toEqual([]);
  });

  it("is deterministic: registry display order (ui.order, then name)", () => {
    const labels = talkingDoorLabels([
      door("zulu", { talks: true, order: 20 }),
      door("alpha", { talks: true, order: 3 }),
      door("mike", { talks: true, order: 3 }),
    ]);
    expect(labels).toEqual(["alpha", "mike", "zulu"]);
  });

  it("returns [] when nothing installed can speak", () => {
    expect(talkingDoorLabels([door("look-only")])).toEqual([]);
    expect(talkingDoorLabels([])).toEqual([]);
  });
});

describe("cf#919 spokenLinesRefusalMessage", () => {
  const installed = [door("seedance", { talks: true, order: 5 }), door("google-veo", { talks: true, order: 6 })];

  it("offers only doors this deploy has, and names no absent one", () => {
    const msg = spokenLinesRefusalMessage(installed, door("look-only"), true);
    expect(msg).toMatch(/seedance/);
    expect(msg).toMatch(/google-veo/);
    // The seven names the old literal carried. Each of these is a door that may not be installed,
    // and infinitetalk is the one a hosted tenant provably cannot install (cf#919).
    expect(msg).not.toMatch(/infinitetalk/i);
    expect(msg).not.toMatch(/vidu/i);
    expect(msg).not.toMatch(/grok/i);
    expect(msg).not.toMatch(/flux/i);
  });

  it("says plainly that no talking door is installed rather than offering an empty pick", () => {
    const msg = spokenLinesRefusalMessage([door("look-only")], door("look-only"), true);
    expect(msg).toMatch(/no talking door/i);
    // An empty parenthetical ("Pick a talking door ()") is the bug this guards.
    expect(msg).not.toMatch(/\(\s*\)/);
    expect(msg).not.toMatch(/Pick a talking door/);
  });

  it("when the door CAN speak and only the audio switch is off, it says THAT", () => {
    // The guard is (cannot speak) OR (audio off), so one message served two causes: a filmmaker who
    // picked the right door was told to go pick a different one.
    const msg = spokenLinesRefusalMessage(installed, door("seedance", { talks: true }), false);
    expect(msg).toMatch(/talking audio/i);
    expect(msg).toMatch(/seedance/);
    expect(msg).not.toMatch(/Pick a talking door/);
  });

  it("still lists doors when the chosen door cannot speak, even with audio off", () => {
    const msg = spokenLinesRefusalMessage(installed, door("look-only"), false);
    expect(msg).toMatch(/Pick a talking door/);
  });
});

describe("cf#919 talkingVoiceHonorFor: the voice-honor table is projected before it ships", () => {
  it("drops a row whose module is not installed", () => {
    const rows = talkingVoiceHonorFor([door("cf-seedance", { talks: true })]);
    expect(rows.map((r) => r.name)).toEqual(["cf-seedance"]);
    expect(rows.some((r) => r.name === "infinitetalk")).toBe(false);
  });

  it("keeps the honor verdict intact for a row it does keep", () => {
    const rows = talkingVoiceHonorFor([door("cf-seedance", { talks: true }), door("google-veo", { talks: true })]);
    const seedance = rows.find((r) => r.name === "cf-seedance");
    expect(seedance?.honor).toBe("exact");
    expect(rows.find((r) => r.name === "google-veo")?.honor).toBe("neighborhood");
  });

  it("serves nothing when no motion door is installed", () => {
    expect(talkingVoiceHonorFor([])).toEqual([]);
  });

  it("never invents a row the table does not carry", () => {
    const names = new Set(TALKING_VOICE_HONOR.map((r) => r.name));
    const rows = talkingVoiceHonorFor([door("cf-seedance", { talks: true }), door("brand-new-door", { talks: true })]);
    for (const r of rows) expect(names.has(r.name)).toBe(true);
    expect(rows.some((r) => r.name === "brand-new-door")).toBe(false);
  });
});
