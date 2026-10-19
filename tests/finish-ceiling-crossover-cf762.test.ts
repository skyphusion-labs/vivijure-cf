/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  phaseCeiling,
  PHASE_HARD_DEADLINE_SECONDS,
  FINISH_STEP_MAX_ATTEMPTS,
  type FilmJob,
  type FinishShot,
} from "@skyphusion-labs/vivijure-core/film-model";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";
import { CEILING_CROSSOVER_SECONDS, ACKNOWLEDGED_ABOVE_CROSSOVER } from "../modules/_shared/finish-ceiling";

// cf#762. `max_invocation_seconds` reads like a local number and is not one: core's phaseCeiling
// derives a GLOBAL per-phase deadline from the largest declared ceiling in the chain, so any value
// above PHASE_HARD_DEADLINE_SECONDS / FINISH_STEP_MAX_ATTEMPTS moves the deadline for every film
// that could reach that module. The declaration sites now say so in a comment. A comment is not a
// mechanism, which is what this file is: raising a ceiling past the crossover without registering
// the decision fails here rather than shipping green.
//
// WHAT IT STRUCTURALLY CANNOT SEE: it reads the manifest SOURCE, so it gates what is declared, not
// what any worker enforces. Whether a declared number matches its door is a fact about another
// repository and is carried at each declaration site as a stated basis, not asserted here.

const ROOT = join(import.meta.dirname, "..");
const MODULES_DIR = join(ROOT, "modules");

interface Declaration {
  module: string;
  file: string;
  seconds: number;
  /** The source line index (0-based) of the declaration, for the comment-proximity check. */
  line: number;
}

function moduleDirs(): string[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .map((e) => e.name)
    .sort();
}

/** Every module whose worker source so much as MENTIONS the field. The denominator. */
function mentioningModules(): string[] {
  return moduleDirs().filter((name) => {
    const f = join(MODULES_DIR, name, "src", "index.ts");
    return existsSync(f) && readFileSync(f, "utf8").includes("max_invocation_seconds");
  });
}

function declarations(): Declaration[] {
  const out: Declaration[] = [];
  for (const name of moduleDirs()) {
    const file = join(MODULES_DIR, name, "src", "index.ts");
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, line) => {
      const m = /^\s*max_invocation_seconds:\s*(\d+)\s*,/.exec(text);
      if (m) out.push({ module: name, file, seconds: Number(m[1]), line });
    });
  }
  return out;
}

const DECLARED = declarations();

describe("cf#762: the 1800 crossover is enforced, not just commented", () => {
  it("the scan sees every module that declares a ceiling (instrument check)", () => {
    // A regex that quietly matches nothing would pass every assertion below. Two guards: the scan
    // is non-empty, and it accounts for every module that mentions the field at all.
    expect(DECLARED.length, "found no max_invocation_seconds declarations at all").toBeGreaterThan(0);
    const found = [...new Set(DECLARED.map((d) => d.module))].sort();
    expect(found, "a module mentions the field but the scan extracted no value from it").toEqual(
      mentioningModules(),
    );
  });

  it("the crossover is derived from core, and it is 1800", () => {
    expect(CEILING_CROSSOVER_SECONDS).toBe(PHASE_HARD_DEADLINE_SECONDS / FINISH_STEP_MAX_ATTEMPTS);
    // Pinned so a core change cannot move the threshold silently: every declaration-site comment in
    // modules/finish-*/src/index.ts names 1800. If this goes red, core moved its floor or its
    // attempt cap; re-derive, then rewrite those comments before changing this number.
    expect(CEILING_CROSSOVER_SECONDS, "core moved the crossover; the module comments now lie").toBe(1800);
  });

  it("no declared ceiling crosses it without a registered acknowledgement", () => {
    for (const d of DECLARED) {
      const ack = ACKNOWLEDGED_ABOVE_CROSSOVER[d.module];
      if (d.seconds <= CEILING_CROSSOVER_SECONDS) {
        expect(ack, `${d.module} is registered above the crossover but declares ${d.seconds}`).toBeUndefined();
        continue;
      }
      expect(
        ack,
        `${d.module} declares ${d.seconds}s, above the ${CEILING_CROSSOVER_SECONDS}s crossover. ` +
          `That moves core's effective phase deadline to ${FINISH_STEP_MAX_ATTEMPTS * d.seconds}s ` +
          `(from the ${PHASE_HARD_DEADLINE_SECONDS}s floor) for every film whose finish chain can ` +
          `reach it. If that is intended, register it in ACKNOWLEDGED_ABOVE_CROSSOVER in ` +
          `modules/_shared/finish-ceiling.ts with the consequence written out.`,
      ).toBeDefined();
      expect(ack.seconds, `${d.module}: the acknowledgement is stale, it names ${ack.seconds}s`).toBe(d.seconds);
      expect(ack.reason.trim().length, `${d.module}: an acknowledgement needs a reason`).toBeGreaterThan(0);
    }
  });

  it("an acknowledgement cannot outlive the declaration it covers", () => {
    const declaring = new Set(DECLARED.map((d) => d.module));
    for (const name of Object.keys(ACKNOWLEDGED_ABOVE_CROSSOVER)) {
      expect(declaring.has(name), `${name} is acknowledged but declares no ceiling`).toBe(true);
    }
  });

  it("every declaration site names the threshold where it is edited", () => {
    for (const d of DECLARED) {
      const above = readFileSync(d.file, "utf8").split("\n").slice(Math.max(0, d.line - 30), d.line).join("\n");
      expect(
        above,
        `${d.module}: nothing within 30 lines above the declaration names ${CEILING_CROSSOVER_SECONDS}. ` +
          `The next person to raise this number will not read film-model.ts first.`,
      ).toContain(String(CEILING_CROSSOVER_SECONDS));
    }
  });
});

// The arithmetic the comments assert, taken from core's own function rather than restated. A
// comment claiming a property the code lacks is how a reviewer signs off on an unguarded path, so
// this runs phaseCeiling at the crossover and one second past it.
function finishJob(): FilmJob {
  return {
    film_id: "film-cf762",
    project: "neon",
    bundle_key: "b",
    scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
    motion_backend: "own-gpu",
    motion_config: {},
    finish_config: {},
    keyframe_binding: null,
    phase: "finish",
    clips_only: true,
    finish_shots: [
      {
        shot_id: "shot_01",
        clip_key: "renders/neon/clips/shot_01_i2v.mp4",
        chain: ["MODULE_FINISH_UNDER_TEST"],
        configs: [{}],
        idx: 0,
        status: "pending",
        applied: [],
      },
    ] as FinishShot[],
    created_at: Date.now(),
  };
}

function moduleDeclaring(seconds: number): RegisteredModule {
  return {
    binding: "MODULE_FINISH_UNDER_TEST",
    name: "finish-under-test",
    version: "1.0.0",
    api: "vivijure-module/2",
    hooks: ["finish"],
    max_invocation_seconds: seconds,
  };
}

describe("cf#762: core's own phaseCeiling, at the crossover and one second past it", () => {
  it("at the crossover the floor still wins", () => {
    const c = phaseCeiling(finishJob(), [moduleDeclaring(CEILING_CROSSOVER_SECONDS)]);
    expect(c.requiredSeconds).toBe(PHASE_HARD_DEADLINE_SECONDS);
    expect(c.seconds).toBe(PHASE_HARD_DEADLINE_SECONDS);
    expect(c.basis).toBe("floor");
  });

  it("one second past it, the global deadline moves", () => {
    const c = phaseCeiling(finishJob(), [moduleDeclaring(CEILING_CROSSOVER_SECONDS + 1)]);
    expect(c.requiredSeconds).toBe(FINISH_STEP_MAX_ATTEMPTS * (CEILING_CROSSOVER_SECONDS + 1));
    expect(c.seconds).toBeGreaterThan(PHASE_HARD_DEADLINE_SECONDS);
    expect(c.basis).toBe("derived");
  });

  it("what ships today (900 on every finish door) leaves the floor untouched", () => {
    const c = phaseCeiling(finishJob(), [moduleDeclaring(900)]);
    expect(c.requiredSeconds).toBe(2700);
    expect(c.seconds).toBe(PHASE_HARD_DEADLINE_SECONDS);
    expect(c.basis).toBe("floor");
  });
});
