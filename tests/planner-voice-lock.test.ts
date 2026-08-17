/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const castJs = readFileSync("public/planner-cast.js", "utf8");
const renderJs = readFileSync("public/planner-render.js", "utf8");
const stateJs = readFileSync("public/planner-state.js", "utf8");
const restoreJs = readFileSync("public/planner-restore.js", "utf8");
const configJs = readFileSync("public/planner-render-config.js", "utf8");
const html = readFileSync("public/planner.html", "utf8");

function loadVoiceLockHelpers(planState: {
  castCatalog: Array<{ id: string; name: string; voice_id?: string | null }>;
  castBindings: Record<string, string>;
}, voiceValue = "") {
  const el = { value: voiceValue };
  const persistCalls = { n: 0 };
  const document = {
    getElementById(id: string) {
      return id === "planner-voice-lock" ? el : null;
    },
  };
  const fn = new Function(
    "planState",
    "SLOT_IDS",
    "document",
    "persistSoon",
    castJs + "\nreturn { buildPlannerVoiceLock, ensureVoiceLockFilled };",
  );
  const helpers = fn(
    planState,
    ["A", "B", "C", "D"],
    document,
    () => { persistCalls.n += 1; },
  ) as {
    buildPlannerVoiceLock: () => string;
    ensureVoiceLockFilled: () => string;
  };
  return { helpers, el, persistCalls };
}

describe("planner voice lock from Cast", () => {
  it("names each bound speaker and attaches the Aura timbre hint", () => {
    const { helpers } = loadVoiceLockHelpers({
      castCatalog: [
        { id: "c1", name: "Mara", voice_id: "asteria" },
        { id: "c2", name: "Dex", voice_id: "zeus" },
      ],
      castBindings: { A: "c1", B: "c2" },
    });
    const lock = helpers.buildPlannerVoiceLock();
    expect(lock).toContain("Mara: clear mid female, American. Same speaker every shot.");
    expect(lock).toContain("Dex: deep resonant male, American. Same speaker every shot.");
    expect(lock).toContain("Never invent a new speaker");
  });

  it("falls back to a same-voice line when the member has no voice_id", () => {
    const { helpers } = loadVoiceLockHelpers({
      castCatalog: [{ id: "c1", name: "Wren", voice_id: null }],
      castBindings: { A: "c1" },
    });
    expect(helpers.buildPlannerVoiceLock()).toBe("Wren: same speaking voice every shot.");
  });

  it("ensureVoiceLockFilled writes Cast text only when the textarea is empty", () => {
    const empty = loadVoiceLockHelpers({
      castCatalog: [{ id: "c1", name: "Mara", voice_id: "asteria" }],
      castBindings: { A: "c1" },
    });
    const filled = empty.helpers.ensureVoiceLockFilled();
    expect(filled).toContain("Mara: clear mid female");
    expect(empty.el.value).toBe(filled);
    expect(empty.persistCalls.n).toBe(1);

    const typed = loadVoiceLockHelpers({
      castCatalog: [{ id: "c1", name: "Mara", voice_id: "asteria" }],
      castBindings: { A: "c1" },
    }, "low alto, calm, slight Texas accent");
    expect(typed.helpers.ensureVoiceLockFilled()).toBe("low alto, calm, slight Texas accent");
    expect(typed.el.value).toBe("low alto, calm, slight Texas accent");
    expect(typed.persistCalls.n).toBe(0);
  });

  it("duplicates every core Aura timbre hint locally", () => {
    const expected: Record<string, string> = {
      angus: "warm mid male, slight Irish lilt",
      asteria: "clear mid female, American",
      arcas: "steady mid male, American",
      orion: "deeper male, American",
      orpheus: "smooth mid male, American",
      athena: "clear mid female, American",
      luna: "light female, American",
      zeus: "deep resonant male, American",
      perseus: "firm mid male, American",
      helios: "bright mid male, American",
      hera: "warm mid female, American",
      stella: "bright female, American",
    };
    for (const [id, hint] of Object.entries(expected)) {
      expect(castJs).toContain(id + ': "' + hint + '"');
    }
  });
});

describe("planner voice lock wiring", () => {
  it("notes under the textarea that native audio invents a speaker unless filled", () => {
    const noteIdx = html.indexOf('id="planner-voice-lock-note"');
    const taIdx = html.indexOf('id="planner-voice-lock"');
    expect(taIdx).toBeGreaterThan(0);
    expect(noteIdx).toBeGreaterThan(taIdx);
    expect(html).toMatch(/Native audio invents a new speaker every shot unless this is filled/);
    expect(html).toMatch(/We fill it from Cast/);
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });

  it("renderPanel prefills via ensureVoiceLockFilled", () => {
    expect(configJs).toMatch(/ensureVoiceLockFilled/);
  });

  it("both submit paths fill then send voice_lock, and block empty native-audio motion", () => {
    expect(renderJs).toMatch(/function requirePlannerVoiceLock/);
    expect(renderJs).toMatch(/function plannerGenerateAudioOn/);
    expect(renderJs.match(/requirePlannerVoiceLock/g)?.length).toBeGreaterThanOrEqual(3);
    expect(renderJs).toMatch(/reqBody\.voice_lock = voiceLock/);
    expect(renderJs).toMatch(/reqBody\.voice_lock = scatterVoiceLock/);
    expect(renderJs).toMatch(/Lock a speaking voice or pick Cast first/);
    expect(renderJs).toMatch(/data-field="generate_audio"/);
  });

  it("persists and restores style lock + voice lock", () => {
    expect(stateJs).toMatch(/styleLock: readVal\("#planner-style-lock"\)/);
    expect(stateJs).toMatch(/voiceLock: readVal\("#planner-voice-lock"\)/);
    expect(restoreJs).toMatch(/setFilmField\("#planner-style-lock", saved\.styleLock\)/);
    expect(restoreJs).toMatch(/setFilmField\("#planner-voice-lock", saved\.voiceLock\)/);
  });

  it("cast helpers load before render submit (script order)", () => {
    const castIdx = html.indexOf('src="planner-cast.js"');
    const renderIdx = html.indexOf('src="planner-render.js"');
    const configIdx = html.indexOf('src="planner-render-config.js"');
    expect(castIdx).toBeGreaterThan(0);
    expect(renderIdx).toBeGreaterThan(castIdx);
    expect(configIdx).toBeGreaterThan(0);
  });
});
