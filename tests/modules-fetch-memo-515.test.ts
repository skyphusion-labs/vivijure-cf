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

  it("planner-registry.js is still the ONE memoised fetcher", () => {
    const code = codeLines(readPublic("planner-registry.js"));
    expect(code).toContain('fetch("/api/modules")');
    // The memo itself: without loadPromise this file becomes a fourth un-memoised caller.
    expect(code).toContain("if (!loadPromise)");
    expect(code).toContain("if (cache) return Promise.resolve(cache)");
  });

  it("the planner page has exactly ONE direct /api/modules fetcher left among its own scripts", () => {
    // Denominator asserted, so a zero here would be a harness failure rather than a pass.
    const plannerOwn = ["planner-registry.js", "planner-render-config.js"];
    const hits = plannerOwn.filter((f) =>
      /fetch\("\/api\/modules"\)/.test(codeLines(readPublic(f))));
    expect(plannerOwn.length).toBe(2);
    expect(hits).toEqual(["planner-registry.js"]);
  });

  it("DECLARED OUT OF SCOPE: the page-chrome fetchers keep their own request", () => {
    // abuse-link.js, hook-availability.js and demo-steer.js also read /api/modules. All three
    // DO load on planner.html alongside planner-registry.js, so the barrier is not that the memo
    // is unavailable to them there; it is that each ALSO loads on pages that do not ship the
    // registry (cast.html, modules.html, settings.html), so none can depend on it
    // unconditionally without a new shared primitive. Measured and left alone deliberately;
    // asserted so their absence from this change reads as a decision and not an oversight.
    for (const f of ["abuse-link.js", "hook-availability.js", "demo-steer.js"]) {
      expect(codeLines(readPublic(f))).toContain('fetch("/api/modules")');
    }
    // Control, and it proves something narrower than the sentence above needs: cast.html ships
    // a chrome fetcher and does NOT ship planner-registry.js, which is the half of the reason
    // that actually blocks routing these three through the memo. It says nothing about
    // planner.html, where all three DO load alongside the registry.
    expect(readPublic("cast.html")).not.toContain('<script src="planner-registry.js">');
  });
});
