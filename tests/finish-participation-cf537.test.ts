import { describe, it, expect } from "vitest";
import { checkManifest, allPass, failures } from "@skyphusion-labs/vivijure-core/modules/conformance";
import { parseHookSelection, resolveModuleRenderConfigs } from "@skyphusion-labs/vivijure-core/render-module-config";
import { selectForChain } from "@skyphusion-labs/vivijure-core/modules/render-pipeline";
import { MODULE_API, type RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";
import { MANIFEST as BLENDER } from "../modules/finish-blender/src/index";
import { MANIFEST as RIFE } from "../modules/finish-rife/src/index";
import { MANIFEST as LIPSYNC } from "../modules/finish-lipsync/src/index";
import { MANIFEST as UPSCALE } from "../modules/finish-upscale/src/index";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// cf#537, the cf half. The core owns the mechanism; this suite is about the FOUR SHIPPED MANIFESTS
// and the TWO RENDER DOORS, and it reads the manifests that actually deploy rather than copies.
//
// The two doors are separate pipelines and this is the whole reason the cf half needs its own tests:
//   - the PANEL door carries a `renderOverrides` bag, resolved by the core
//   - the AGENT / MCP / Slate door (`POST /api/render/film`) carries NO bag at all -- it takes
//     PRE-RESOLVED `*_config` maps directly
// A selection wired into one is not wired into the other, and driving one exercises nothing about
// the other.

const MANIFESTS = [
  { name: "finish-blender", m: BLENDER, expect: "opt_in" as const },
  { name: "finish-rife", m: RIFE, expect: "default" as const },
  { name: "finish-lipsync", m: LIPSYNC, expect: "default" as const },
  { name: "finish-upscale", m: UPSCALE, expect: "default" as const },
];

describe("cf#537: the SHIPPED finish manifests declare their participation", () => {
  it("CONTROL: these really are the shipped manifests and they really serve `finish`", () => {
    // Run first. Every row below reads a field off these objects; if they are not the manifests that
    // deploy, or do not serve the hook the gate is about, nothing beneath this is a finding.
    expect(MANIFESTS.length, "DENOMINATOR: finish modules in this repo").toBe(4);
    for (const { name, m } of MANIFESTS) {
      expect(m.name, `${name}: manifest.name`).toBe(name);
      expect(m.api).toBe(MODULE_API);
      expect(m.hooks, `${name} must serve finish`).toContain("finish");
    }
  });

  it("every one declares an EXPLICIT participation (absence is a signal, not a default)", () => {
    const declared = MANIFESTS.filter((x) => x.m.participation !== undefined);
    expect(declared.length, `${declared.length} of ${MANIFESTS.length} finish manifests declare participation`).toBe(4);
  });

  it("finish-blender is the ONLY opt_in module, and the other three are unchanged", () => {
    const optIn = MANIFESTS.filter((x) => x.m.participation === "opt_in").map((x) => x.name);
    expect(optIn, `1 of ${MANIFESTS.length} is opt_in`).toEqual(["finish-blender"]);
    for (const { name, m, expect: want } of MANIFESTS) {
      expect(m.participation, `${name}`).toBe(want);
    }
  });

  it("all four still pass conformance with the field present", () => {
    for (const { name, m } of MANIFESTS) {
      const checks = checkManifest(m);
      expect(allPass(checks), `${name}: ${JSON.stringify(failures(checks))}`).toBe(true);
    }
  });

  it("CONTROL: conformance can still FAIL -- stripping the field reddens it", () => {
    // Without this, "all four pass" is consistent with a checker that passes everything. Reconstruct
    // the pre-cf#537 manifest and watch the gate refuse it.
    const stripped = { ...BLENDER } as Record<string, unknown>;
    delete stripped.participation;
    const checks = checkManifest(stripped);
    expect(allPass(checks)).toBe(false);
    expect(failures(checks).map((c) => c.name)).toContain("participation");
  });

  it("finish-blender's default preset is UNTOUCHED by this change", () => {
    // Deliberately pinned. The ruling separated "should blender run at all" from "should its default
    // be neutral", and folding the second into this change would make the first impossible to
    // measure. If someone later changes the default, this row says it was a decision.
    const preset = (BLENDER.config_schema as Record<string, { default?: unknown }>).preset;
    const strength = (BLENDER.config_schema as Record<string, { default?: unknown }>).strength;
    expect(preset?.default).toBe("filmic_warm");
    expect(strength?.default).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

const mod = (name: string, order: number, participation?: "default" | "opt_in"): RegisteredModule => ({
  name, version: "0.0.0", api: MODULE_API, hooks: ["finish"], ui: { order },
  ...(participation ? { participation } : {}),
  binding: "MODULE_" + name.toUpperCase().replace(/-/g, "_"),
});

// The REAL declared orders, so this is not a fixture that happens to agree with the shipped set.
const SERVING = [
  mod("finish-rife", RIFE.ui?.order ?? 10, RIFE.participation),
  mod("finish-lipsync", LIPSYNC.ui?.order ?? 15, LIPSYNC.participation),
  mod("finish-blender", BLENDER.ui?.order ?? 18, BLENDER.participation),
  mod("finish-upscale", UPSCALE.ui?.order ?? 20, UPSCALE.participation),
];
const names = (ms: { name: string }[]) => ms.map((m) => m.name);

describe("cf#537: the shipped manifests produce the ruled behaviour end to end", () => {
  it("THE TICKET: with no selection, the real four resolve to three -- blender excluded", () => {
    const got = selectForChain(SERVING, "finish", undefined);
    expect(names(got.modules)).toEqual(["finish-rife", "finish-lipsync", "finish-upscale"]);
    expect(got.modules.length, `3 of ${SERVING.length} shipped finish modules run by default`).toBe(3);
  });

  it("naming blender runs it -- opt_in is 'not unless asked', never 'not ever'", () => {
    const got = selectForChain(SERVING, "finish", { mode: "named", modules: ["finish-blender"] });
    expect(names(got.modules)).toEqual(["finish-blender"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("cf#537 DOOR 1 (panel): a selection in the renderOverrides bag reaches the resolved plan", () => {
  it("resolves finish_select out of the bag the panel already sends", () => {
    const resolved = resolveModuleRenderConfigs(
      { select: { finish: { mode: "named", modules: ["finish-upscale"] } } },
      "final",
      SERVING,
    );
    expect(resolved.finish_select).toEqual({ mode: "named", modules: ["finish-upscale"] });
  });

  it("NEGATIVE CONTROL: a bag with no selection resolves to NO finish_select", () => {
    const resolved = resolveModuleRenderConfigs({ config: {} }, "final", SERVING);
    expect(resolved.finish_select).toBeUndefined();
  });

  it("the REPLAY paths inherit it, because it lives inside the persisted bag", () => {
    // regen-shot / finalize / animate-cloud / animate-hybrid send NO render config and replay
    // `renders.render_overrides`. Round-tripping the bag through JSON is what those paths do, so
    // this is the property they depend on, tested rather than asserted.
    const bag = { motion_backend: "own-gpu", select: { finish: { mode: "named", modules: ["finish-blender"] } } };
    const replayed = JSON.parse(JSON.stringify(bag));
    const resolved = resolveModuleRenderConfigs(replayed, "final", SERVING);
    expect(resolved.finish_select).toEqual({ mode: "named", modules: ["finish-blender"] });
  });
});

describe("cf#537 DOOR 2 (agent / MCP / Slate): the body's finish_select is VALIDATED, not trusted", () => {
  // This door reads untrusted JSON and holds no overrides bag, so its field is top-level and goes
  // through the SAME parser the panel bag does -- one definition of "a valid selection", not two.
  const door = (raw: unknown) => parseHookSelection({ finish: raw })?.finish;

  it("accepts a well-formed named selection", () => {
    expect(door({ mode: "named", modules: ["finish-blender"] })).toEqual({ mode: "named", modules: ["finish-blender"] });
  });

  it("accepts an explicit empty selection as ZERO modules, not as absence", () => {
    expect(door({ mode: "named", modules: [] })).toEqual({ mode: "named", modules: [] });
  });

  it("accepts { mode: \"default\" }", () => {
    expect(door({ mode: "default" })).toEqual({ mode: "default" });
  });

  it("REFUSES malformed shapes rather than inventing a mode", () => {
    // Every one of these resolves to ABSENT, which is the default-participation set -- still without
    // blender. The safe direction: a garbage payload must never re-enable an opt_in module.
    for (const bad of [undefined, null, "finish-blender", ["finish-blender"], 7,
                       { modules: ["finish-blender"] }, { mode: "sideways" }, { mode: "named" }]) {
      expect(door(bad), `payload ${JSON.stringify(bad)} must not parse`).toBeUndefined();
    }
  });

  it("CONTROL: the parser is not simply refusing everything", () => {
    // Paired with the row above, and run for the reason that row exists: a parser that returned
    // undefined unconditionally would pass the refusal test perfectly.
    expect(door({ mode: "named", modules: ["finish-rife"] })).toBeDefined();
  });

  it("strips junk entries but keeps the selection", () => {
    expect(door({ mode: "named", modules: ["finish-rife", "", "   ", 7, null] }))
      .toEqual({ mode: "named", modules: ["finish-rife"] });
  });
});

// ---------------------------------------------------------------------------------------------
// DOOR-FORWARDING SWEEP.
//
// The rows above prove the PARSER and the RESOLVER. They say nothing about whether each door
// actually hands the resolved selection to the mint, and a mutation pass confirmed that: deleting
// `finish_select: mapped.finish_select` from a handler left every test above green. The identical
// hole appeared in the core PR and was found the same way.
//
// This is a SOURCE-level assertion and that is the weaker kind, so it says so: it pins the shape an
// omission takes. It is here because cf's render handlers are worker routes with no cheap seam, and
// a stated weak check beats an unstated absent one. The behavioural half lives in the core wiring
// suite, which drives the consumption point through advanceFilmJob for real.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("cf#537 door sweep: every site that hands a finish_config to a mint also hands finish_select", () => {
  // DERIVED from the shape, not transcribed: any cf source file passing a resolved finish_config
  // into startFilmJob / startFilmFromKeyframes is a door that must forward the selection too.
  const FILES = ["index.ts", "finalize-from-keyframes.ts"];

  it("CONTROL: the matcher can find a known-present token AND come back empty", () => {
    // Run first. Every row below is "this file contains X"; a matcher that cannot find something it
    // should, or cannot miss something it should not, makes the rest of this block decorative.
    const idx = readFileSync(resolve(SRC, "index.ts"), "utf8");
    expect(idx.includes("startFilmJob("), "index.ts must mint films").toBe(true);
    expect(idx.includes("no_such_token_cf537"), "the matcher must be able to return false").toBe(false);
  });

  it("every mint site that passes finish_config also passes finish_select", () => {
    let mints = 0;
    for (const f of FILES) {
      const src = readFileSync(resolve(SRC, f), "utf8");
      // TOKEN match, not substring: `finish_config` is a SUBSTRING of `film_finish_config`, and the
      // first draft of this sweep counted 6 mint sites in index.ts where there are 3 -- every extra
      // hit was the film.finish field. A loose matcher that returns almost everything has failed as
      // completely as one returning nothing; it was caught only because the count disagreed with the
      // prediction and the count was chased instead of the prediction being adjusted.
      const n = (src.match(/(?<![_A-Za-z])finish_config: /g) ?? []).length;
      if (!n) continue;
      mints += n;
      const sel = (src.match(/(?<![_A-Za-z])finish_select: /g) ?? []).length;
      expect(
        sel,
        `${f} passes finish_config into a mint ${n} time(s) but forwards finish_select ${sel} time(s) (cf#537)`,
      ).toBe(n);
    }
    // DENOMINATOR. A zero here means the sweep matched nothing and every row above is vacuous --
    // which is exactly how a guard stops guarding after a rename, silently and in the green direction.
    expect(mints, `${mints} finish_config mint arguments found across ${FILES.length} files`).toBe(4);
  });

  it("the AGENT door validates rather than trusts its body field", () => {
    // The panel door's selection is parsed by the core on the way through the overrides bag. The
    // agent door has no bag, so if it forwarded `a.finish_select` raw, an untrusted body would reach
    // the job doc unvalidated. Pin that it goes through the shared parser.
    const idx = readFileSync(resolve(SRC, "index.ts"), "utf8");
    expect(idx.includes("resolveAgentFinishSelect(a.finish_select, a.finish_config)")).toBe(true);
    expect(idx, "the raw body field must never be forwarded directly").not.toMatch(/finish_select: a\.finish_select\b/);
    // cf#386: the resolved selection is what is minted, never the raw body and never a silent default.
    expect(idx).toMatch(/finish_select:\s*filmFinishSelect/);
  });
});
