// cf#515 (adjacent, in-lane): the planner made FIVE requests for GET /api/modules per page
// load where planner-registry.js's own header says "one fetch of GET /api/modules".
//
// The sharpest instance, and the only one this change touches: renderPanel() in
// planner-render-config.js awaited the MEMOISED registry and then, on the very next line,
// issued its own un-memoised fetch for the same payload. One function, two requests for one
// thing, adjacent lines. The file contradicted itself.
//
// NOT a per-poll fan-out, corrected in the de-escalating direction: renderPanel() is called
// once, from planner-init.js, at init. No poll loop touches it. It is a per-page-load cost.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const readPublic = (name: string) => readFileSync(process.cwd() + "/public/" + name, "utf8");
const codeLines = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("cf#515: the planner fetches /api/modules through the shared memo", () => {
  it("planner-render-config.js no longer fetches /api/modules itself", () => {
    const code = codeLines(readPublic("planner-render-config.js"));
    // POSITIVE CONTROL FIRST: plant the pattern and prove the matcher sees it, or the null
    // below is a statement about the regex rather than about the file.
    expect((code + '\n    const resp = await fetch("/api/modules");')
      .match(/fetch\("\/api\/modules"\)/g)?.length).toBe(1);
    expect(code.match(/fetch\("\/api\/modules"\)/g)).toBe(null);
    // And it uses what the memo returns rather than discarding it.
    expect(code).toContain("const data = await global.plannerRegistry.load();");
  });

  it("planner-registry.js no longer OWNS the memo -- cf#580 moved it one file over", () => {
    // This assertion used to read "still the ONE memoised fetcher" and check for loadPromise here.
    // cf#580 moved the memo to module-registry.js so all four pages share one request instead of the
    // planner alone sharing one. Keeping a memo here TOO would be this defect relocated: planner.html
    // would make two requests, one for the page chrome and one for the planner controls.
    const code = codeLines(readPublic("planner-registry.js"));
    expect(code).not.toContain("loadPromise");
    expect(code).toContain(".load()");
    // The behaviour of the memo itself is asserted in tests/modules-fetch-memo-580.test.ts, against
    // module-registry.js, where it now lives.
  });

  it("neither planner-owned script fetches the projection directly any more", () => {
    // This test used to assert expect(plannerOwn.length).toBe(2) over its OWN literal array, which
    // proves the array has two entries and nothing at all about the tree. The population is now
    // derived from the filesystem, by a union of matchers, in tests/modules-fetch-memo-580.test.ts;
    // what is left here is the narrow cf#515 claim about these two specific files.
    const plannerOwn = ["planner-registry.js", "planner-render-config.js"];
    const hits = plannerOwn.filter((f) =>
      /fetch\("\/api\/modules"\)/.test(codeLines(readPublic(f))));
    expect(hits).toEqual([]);
  });

  it("WAS out of scope, CLOSED by cf#580: the page-chrome fetchers now share the memo", () => {
    // This test used to assert the opposite, and its reason was sound at the time: abuse-link.js,
    // hook-availability.js and demo-steer.js each ALSO load on pages that do not ship
    // planner-registry.js, so none could depend on it without a new shared primitive. cf#580 built
    // that primitive (module-registry.js, loaded on all four pages), which removed the barrier
    // rather than the requirement. Inverted here rather than deleted, so the record shows the
    // out-of-scope declaration was discharged and not quietly dropped.
    // SHAPE-AGNOSTIC on purpose. The assertion this replaces used a literal substring, and that
    // is the same blindness that let two real call sites go uncounted: a literal cannot see
    // origFetch(...) or a call with a second argument. This one catches a file silently GAINING
    // a fetch of ANY shape as well as silently LOSING the memo read, which is what the original
    // caught today. Full population + controls live in tests/modules-fetch-memo-580.test.ts.
    const anyModulesFetch = (src: string) =>
      /[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*"\/api\/modules"\s*[,)]/.test(src) ||
      /"\/api\/modules"(?!\/)/.test(src);
    for (const f of ["abuse-link.js", "hook-availability.js", "demo-steer.js"]) {
      expect(anyModulesFetch(codeLines(readPublic(f))), f + " fetches /api/modules directly").toBe(false);
      expect(codeLines(readPublic(f)), f + " does not read the shared memo").toContain("moduleRegistry.load()");
    }
    // The stated barrier, gone: the page that could not have the memo now loads it.
    expect(readPublic("cast.html")).not.toContain('<script src="planner-registry.js">');
    expect(readPublic("cast.html")).toContain('<script src="module-registry.js">');
  });
});
