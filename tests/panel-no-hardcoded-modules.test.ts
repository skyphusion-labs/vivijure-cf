/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";

// The panel is a PROJECTION of the registry: it renders from GET /api/modules and never compiles a
// module name into itself. A hardcoded name goes stale the moment the module is renamed, retired, or
// simply not installed on this studio, and the panel then offers something no host can serve.
//
// cf#780 rewrote this file. The previous version pinned a hand-written list of SIX cloud
// motion.backend names, and it was green -- because none of those six appeared. Meanwhile seven
// OTHER module names were compiled into the panel across 21 sites, including a hand-kept pair list
// in planner-render-config.js that made a third opt_in `finish` module unreachable from the UI.
// A guard whose corpus is narrower than the defect class reports the reassuring state. So the
// corpus is now DERIVED from the installed module set rather than typed out, and the exemptions
// are a RATCHET: an undeclared name fails, and a declared one that has been paid off also fails,
// so the list can neither grow silently nor rot.

const ROOT = process.cwd();

// ---- derived corpus ---------------------------------------------------------
// Every module in this repo is a candidate name. `_shared` is a library, not a module.
const MODULE_NAMES = readdirSync(`${ROOT}/modules`, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
  .map((e) => e.name)
  .sort();

/** Hook names, also derived, from the manifests that declare them. A module may share its name
 *  with a hook (`keyframe` is both), and a hook name in the panel is the panel doing its job.
 *  Subtracting the collision is the one thing this sweep structurally cannot see; it is derived
 *  rather than typed so a future collision is handled the same way without an edit here. */
const HOOK_NAMES = new Set<string>();
for (const name of MODULE_NAMES) {
  for (const rel of [`modules/${name}/src/index.ts`, `modules/${name}/src/manifest.ts`]) {
    if (!existsSync(`${ROOT}/${rel}`)) continue;
    const decl = readFileSync(`${ROOT}/${rel}`, "utf8").match(/hooks:\s*\[([^\]]*)\]/);
    if (!decl) continue;
    for (const m of decl[1].matchAll(/["']([a-z.]+)["']/g)) HOOK_NAMES.add(m[1]);
  }
}
const CORPUS = MODULE_NAMES.filter((n) => !HOOK_NAMES.has(n));

// ---- declared exemptions ----------------------------------------------------
// Each entry is a name, the exact sites, and WHY. "Declared" does not mean "fine"; it means
// visible. Each remaining one is debt with a named way out. The finish-lipsync /
// speech-upscale PAIR was paid off in cf#783 (MuseTalk ruled out, module removed, so the
// coupling has no subject) and is deleted here rather than left as a graveyard entry, which is
// what the ratchet in the third test below demands.
const DECLARED: Record<string, { sites: string[]; why: string }> = {
  "own-gpu": {
    sites: ["planner-registry.js", "planner-render-config.js"],
    why: "rollout-window fallback for modules that predate ui.locality; retires with that window",
  },
  "local-gpu": {
    sites: ["planner-render-config.js"],
    why: "suppressed from the projected config list and from the cloud-keyframe default; predates cf#780",
  },
  "cf-seedance": {
    sites: ["cast.js"],
    why: "voice-sample copy names the one door that can lock a take; product copy, needs a capability flag to generalise",
  },
  "finish-blender": {
    sites: ["planner-restore.js"],
    why: "legacy draft key only (LEGACY_FINISH_PICK_KEYS); retires once saved drafts age out",
  },
};

// ---- the sweep --------------------------------------------------------------
const PANEL = readdirSync(`${ROOT}/public`)
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ file: f, src: readFileSync(`${ROOT}/public/${f}`, "utf8") }));

/** Strip line and block comments: several fixes left an explanatory comment that NAMES the module
 *  it removed, and a matcher that cannot tell prose from code would fail on the explanation. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every (name, file) pair where a corpus name appears as a string literal in panel CODE. */
function hardcodedPairs(panel = PANEL, corpus = CORPUS): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = [];
  for (const { file, src } of panel) {
    const body = code(src);
    for (const name of corpus) {
      if (body.includes(`"${name}"`) || body.includes(`'${name}'`)) out.push({ name, file });
    }
  }
  return out;
}

describe("the panel compiles in no UNDECLARED module name", () => {
  it("the corpus is derived from the installed modules, not typed out", () => {
    // The bug this file was rewritten for was a corpus of 6 hand-picked names. Assert the corpus
    // is the real module set, and that it reaches names the old list could never have contained.
    expect(MODULE_NAMES.length).toBeGreaterThan(20);
    expect(MODULE_NAMES).toContain("finish-rife");
    expect(MODULE_NAMES).toContain("finish-blender");
    expect(MODULE_NAMES).toContain("speech-upscale");
    expect(CORPUS.length).toBe(MODULE_NAMES.length - MODULE_NAMES.filter((n) => HOOK_NAMES.has(n)).length);
    expect(HOOK_NAMES.has("keyframe"), "hook names must be derived, not assumed").toBe(true);
  });

  it("no module name appears as a string literal in panel CODE unless it is declared", () => {
    const undeclared = hardcodedPairs()
      .filter(({ name, file }) => !(DECLARED[name] && DECLARED[name].sites.includes(file)))
      .map(({ name, file }) => `${file}: ${name}`)
      .sort();
    expect(
      undeclared,
      "a module name is hardcoded in the panel; project it from the registry, or declare it in DECLARED with a reason",
    ).toEqual([]);
  });

  it("every declared exemption is still real (the list is a ratchet, not a graveyard)", () => {
    const actual = new Set(hardcodedPairs().map(({ name, file }) => `${file}: ${name}`));
    const stale: string[] = [];
    for (const [name, { sites }] of Object.entries(DECLARED)) {
      for (const file of sites) {
        if (!actual.has(`${file}: ${name}`)) stale.push(`${file}: ${name}`);
      }
    }
    expect(
      stale.sort(),
      "this exemption is no longer needed; delete it from DECLARED so the list keeps meaning something",
    ).toEqual([]);
  });

  it("the finish picks are projected, not compiled in", () => {
    // cf#780, the specific defect: a hand-kept [module, wrapperId] pair list meant an installed,
    // conformant `finish` module with participation "opt_in" that was not one of those two names
    // got no control and could never be named in the submit.
    const prc = PANEL.find((p) => p.file === "planner-render-config.js");
    expect(prc, "planner-render-config.js is gone; re-anchor this test").toBeTruthy();
    const body = code(prc!.src);
    expect(body).toContain("participation === \"opt_in\"");
    expect(body).not.toContain("planner-finish-lipsync-wrap");
    expect(body).not.toContain("planner-finish-blender-wrap");
    const html = readFileSync(`${ROOT}/public/planner.html`, "utf8");
    expect(html).toContain('id="planner-finish-pick-list"');
    expect(html).not.toMatch(/id="planner-finish-lipsync"/);
    expect(html).not.toMatch(/id="planner-finish-blender"/);
  });

  it("the hybrid submit OMITS the default cloud model rather than inventing one", () => {
    const row = PANEL.find((p) => p.file === "planner-history-row.js");
    expect(row, "planner-history-row.js is gone; re-anchor this test").toBeTruthy();
    expect(code(row!.src)).toContain("if (cloudDefault) hybridBody.defaultCloudModel = cloudDefault;");
  });

  it("POSITIVE CONTROL: the matcher can see a planted name and the stripper works", () => {
    // Without this the sweep passes against an empty corpus, a broken matcher, or an empty panel.
    expect(PANEL.length, "no panel .js files were read").toBeGreaterThan(20);
    const planted = [{ file: "planted.js", src: 'const x = "finish-blender";' }];
    expect(hardcodedPairs(planted)).toEqual([{ name: "finish-blender", file: "planted.js" }]);
    // and it must NOT fire on the same name inside a comment
    const commented = [{ file: "planted.js", src: '// we used to hardcode "finish-blender" here\nconst x = 1;' }];
    expect(hardcodedPairs(commented)).toEqual([]);
  });
});
