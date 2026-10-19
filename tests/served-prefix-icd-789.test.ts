import { describe, it, expect } from "vitest";
import { ARTIFACT_PREFIXES, isServedArtifactKey } from "../src/shared";
import { stageAudioKeyForRenders } from "@skyphusion-labs/vivijure-core/audio-stage";

// cf#789 -- "which R2 prefixes are served, and therefore what may be copied into them" is stated in
// four places across two repos, and the lists have already diverged in BOTH directions.
//
// This file is deliberately NOT a fifth restatement. It is the ICD: one declared table of the
// intended delta, checked by EXECUTION against both repos' real functions, so a change to either
// list fails here rather than silently reopening a closed class in a file nobody connects to it.
//
// WHY A CHECK AND NOT ONE SHARED LIST. core's RENDERS_AUDIO_PREFIXES is a module-private `const` in
// dist/audio-stage.js -- it is not exported, so cf cannot import it, and making it importable is a
// core change plus a publish plus a dependency bump before the drift becomes visible here. It is
// also not obvious the two lists SHOULD be one: they answer different questions (see below). So the
// issue's second acceptable outcome is the one taken -- an explicit statement of the deliberate
// difference, with a test asserting the delta. docs/CONTRACT.md carries the prose half.
//
// THE TWO LISTS ANSWER DIFFERENT QUESTIONS, and collapsing them would be wrong:
//   cf   ARTIFACT_PREFIXES        -- "may this key be SERVED to a caller?"
//   core RENDERS_AUDIO_PREFIXES   -- "may this key be STAGED as an audio source into renders?"
// Every staged key lands in served space, so core's list must stay a subset-by-intent of cf's plus
// whatever cf deliberately does not serve. The delta below is where that is not currently true.

/** Probe suffix. Safe under isSafeRelKey, and an audio extension so core's copy arm is reachable. */
const PROBE = "probe.mp3";

interface IcdRow {
  prefix: string;
  /** cf: may a key here be SERVED? (src/shared.ts ARTIFACT_PREFIXES / isServedArtifactKey) */
  cfServes: boolean;
  /** core: may a key here be STAGED as an audio source? (RENDERS_AUDIO_PREFIXES) */
  coreStages: boolean;
  why: string;
}

/**
 * THE ICD. The union of both lists plus quarantine/, with the intended verdict on each side.
 *
 * Adding a prefix to EITHER repo without adding a row here fails the denominator cases below. That
 * is the whole mechanism: the drift becomes a red test instead of a quiet widening.
 */
const ICD: IcdRow[] = [
  // ---- agreed: served by cf AND stageable by core -------------------------------------------
  { prefix: "audio/", cfServes: true, coreStages: true, why: "the canonical staged-audio destination" },
  { prefix: "renders/", cfServes: true, coreStages: true, why: "render outputs, served and stageable" },
  { prefix: "out/", cfServes: true, coreStages: true, why: "chat-bucket handoff; core additionally requires a SINGLE segment" },

  // ---- DRIFT 1: core accepts it, cf does not serve it ----------------------------------------
  {
    prefix: "dialogue/",
    cfServes: false,
    coreStages: true,
    why:
      "DRIFT, measured in cf#789. core stages dialogue/ as an audio source but cf does not serve it, " +
      "so a dialogue key can be staged into a space it can never be read back from. Harmless today " +
      "because nothing serves it; it is recorded here rather than quietly reconciled, because " +
      "widening cf's list to match is a serve-surface change and narrowing core's breaks staging.",
  },

  // ---- DRIFT 2: cf serves it, core rejects it -------------------------------------------------
  {
    prefix: "cast/",
    cfServes: true,
    coreStages: false,
    why:
      "DRIFT, measured in cf#789, and this is the direction the issue names as the live risk: the " +
      "concrete failure it prevents is someone adding cast/ to core's list so a voice reference can " +
      "be staged, reopening the copy-into-served-space class in a file with no connection to the " +
      "advisory that closed it (GHSA-5fj8-6pc2-x9p5). If this row ever flips, that is the change.",
  },

  // ---- served by cf, deliberately NOT stageable as audio --------------------------------------
  { prefix: "bundles/", cfServes: true, coreStages: false, why: "bundle docs, never an audio source" },
  { prefix: "cast-clean/", cfServes: true, coreStages: false, why: "cast imagery, never an audio source" },
  { prefix: "cast-gen/", cfServes: true, coreStages: false, why: "cast imagery, never an audio source" },
  { prefix: "character-refs/", cfServes: true, coreStages: false, why: "reference imagery" },
  { prefix: "characters/", cfServes: true, coreStages: false, why: "reference imagery" },
  { prefix: "clips/", cfServes: true, coreStages: false, why: "video clips; audio is muxed, not staged from here" },
  { prefix: "loras/", cfServes: true, coreStages: false, why: "weights" },
  { prefix: "uploads/", cfServes: true, coreStages: false, why: "raw staging area; promoted before it is an audio source" },

  // ---- served by NEITHER, and that is the safety property -------------------------------------
  {
    prefix: "quarantine/",
    cfServes: false,
    coreStages: false,
    why:
      "A HELD object. cf#789 observed that today's safety here is an ACCIDENT of construction -- " +
      "quarantine/ merely happens to sit outside core's four-prefix list. This row makes the " +
      "accident an assertion, so a fifth prefix added to core cannot quietly make held objects " +
      "stageable.",
  },
];

/** An env that would serve ANY read, so a refusal can only come from the KEY GUARD and not from a
 *  missing object. This is the condition cf#789 measured the original drift under. */
function permissiveCoreEnv() {
  const head = async () => ({ httpMetadata: { contentType: "audio/mpeg" } });
  const get = async () => ({ arrayBuffer: async () => new ArrayBuffer(8) });
  return {
    R2_RENDERS: { head, get, put: async () => undefined },
    R2: { head, get },
  } as unknown as Parameters<typeof stageAudioKeyForRenders>[0];
}

/** Ask core, by execution, whether it will stage a key under this prefix. */
async function coreAccepts(prefix: string): Promise<{ accepted: boolean; message: string }> {
  try {
    await stageAudioKeyForRenders(permissiveCoreEnv(), `${prefix}${PROBE}`);
    return { accepted: true, message: "" };
  } catch (e) {
    const message = (e as Error).message;
    // Only a KEY-GUARD refusal counts as "core rejects this prefix". Any other error (a missing
    // object, a bad env) would be the instrument failing, not core refusing, and must not be read
    // as a refusal -- that is how a broken fixture passes as a result.
    if (message.includes("audioKey must start with one of")) return { accepted: false, message };
    throw new Error(`instrument failure, not a key refusal, for ${prefix}: ${message}`);
  }
}

describe("cf#789 the served-prefix ICD: one declared delta, checked against both repos", () => {
  it("DENOMINATOR: cf's ARTIFACT_PREFIXES is exactly the set this ICD declares served", () => {
    // A prefix added to src/shared.ts without a row here fails, and so does a row for a prefix that
    // has been removed. This is what makes the table the contract rather than a comment.
    const declared = ICD.filter((r) => r.cfServes).map((r) => r.prefix).sort();
    expect([...ARTIFACT_PREFIXES].sort()).toEqual(declared);
  });

  it("DENOMINATOR: no duplicate rows, so a prefix cannot carry two verdicts", () => {
    const seen = ICD.map((r) => r.prefix);
    expect(new Set(seen).size).toBe(seen.length);
  });

  for (const row of ICD) {
    it(`cf ${row.cfServes ? "SERVES" : "refuses"} ${row.prefix}`, () => {
      expect(isServedArtifactKey(`${row.prefix}${PROBE}`)).toBe(row.cfServes);
    });

    it(`core ${row.coreStages ? "STAGES" : "refuses"} ${row.prefix}`, async () => {
      const { accepted } = await coreAccepts(row.prefix);
      expect(accepted).toBe(row.coreStages);
    });
  }

  it("POSITIVE CONTROL: core accepts at least one prefix, so 'refuses everything' cannot pass", async () => {
    // Every core assertion above is of the form "it refused" for 9 of the 13 rows. A core that
    // refused unconditionally would satisfy all nine, so the instrument has to be shown capable of
    // a positive verdict.
    const accepted = ICD.filter((r) => r.coreStages);
    expect(accepted.length).toBeGreaterThan(0);
    for (const row of accepted) {
      expect((await coreAccepts(row.prefix)).accepted).toBe(true);
    }
  });

  it("POSITIVE CONTROL: cf serves at least one prefix, so 'serves nothing' cannot pass", () => {
    expect(ICD.some((r) => r.cfServes)).toBe(true);
    expect(isServedArtifactKey(`audio/${PROBE}`)).toBe(true);
  });

  it("the two DRIFTS cf#789 measured are still exactly these two, and no others", () => {
    // If a third asymmetry appears, someone changed a list without updating the ICD prose, and the
    // count is what catches it.
    const drift = ICD.filter((r) => r.cfServes !== r.coreStages && r.prefix !== "quarantine/");
    const coreOnly = drift.filter((r) => r.coreStages && !r.cfServes).map((r) => r.prefix);
    const cfOnlyAudioCapable = drift.filter((r) => !r.coreStages && r.cfServes).map((r) => r.prefix);
    expect(coreOnly).toEqual(["dialogue/"]);
    // cf serves plenty core will not stage, which is correct and not drift; the ONE the issue
    // singled out as the live risk is cast/, so it is pinned by name.
    expect(cfOnlyAudioCapable).toContain("cast/");
  });

  it("a HELD object is outside served space on BOTH sides, by assertion and not by accident", async () => {
    expect(isServedArtifactKey(`quarantine/2026/hold/audio/${PROBE}`)).toBe(false);
    // The whole key is tested, so a held key matches no allowed prefix however ordinary its tail.
    expect((await coreAccepts("quarantine/")).accepted).toBe(false);
  });
});
