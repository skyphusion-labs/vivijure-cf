/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

// The panel is a PROJECTION of the registry: it renders from GET /api/modules and never compiles a
// module name into itself. A hardcoded name goes stale the moment the module is renamed, retired, or
// simply not installed on this studio, and the panel then offers something no host can serve.
//
// `planner-history-row.js` carried `|| "seedance"` as the hybrid submit's default cloud model. Note
// what it was NOT: it could only be SENT when `cloudModelOptions()` was empty, and on every host
// where that holds the core discards it (`resolveCloudModel` honours the requested name only if it
// is in the installed cloud set, else `allowed[0]`). So it never reached a render. It is fixed as
// hygiene, and this test exists to keep the class out rather than to commemorate a bug.

const PANEL = readdirSync(`${process.cwd()}/public`)
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ file: f, src: readFileSync(`${process.cwd()}/public/${f}`, "utf8") }));

/** Strip line and block comments: the fix left an explanatory comment that NAMES the module it
 *  removed, and a matcher that cannot tell prose from code would fail on the explanation. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// Cloud motion.backend module names as the live registry reports them. Deliberately a SHORT list of
// the ones a developer might reach for as a placeholder, not an attempt to enumerate the hook.
const CLOUD_MODULE_NAMES = ["seedance", "kling", "minimax-hailuo", "google-veo", "vidu-q3", "alibaba-wan"];

describe("the panel compiles in no module names", () => {
  it("no cloud motion.backend module name appears as a string literal in panel CODE", () => {
    const hits: string[] = [];
    for (const { file, src } of PANEL) {
      const body = code(src);
      for (const name of CLOUD_MODULE_NAMES) {
        if (body.includes(`"${name}"`) || body.includes(`'${name}'`)) hits.push(`${file}: ${name}`);
      }
    }
    expect(hits, "a module name is hardcoded in the panel; project it from the registry instead").toEqual([]);
  });

  it("the hybrid submit OMITS the default cloud model rather than inventing one", () => {
    const row = PANEL.find((p) => p.file === "planner-history-row.js");
    expect(row, "planner-history-row.js is gone; re-anchor this test").toBeTruthy();
    expect(code(row!.src)).toContain("if (cloudDefault) hybridBody.defaultCloudModel = cloudDefault;");
  });

  it("POSITIVE CONTROL: the matcher CAN see a hardcoded name, and the comment stripper works", () => {
    // Both halves. Without the first, the sweep passes against an empty corpus or a broken matcher;
    // without the second, this test would have failed on the explanatory comment left by the fix
    // and someone would have "fixed" it by deleting the explanation.
    expect(PANEL.length, "no panel .js files were read").toBeGreaterThan(20);
    expect(code('const x = "seedance";')).toContain('"seedance"');
    expect(code('// we used to hardcode "seedance" here\nconst x = 1;')).not.toContain('"seedance"');
  });

  it("the one INTENTIONAL name check is declared, not silently exempted", () => {
    // planner-registry.js keys on the literal `own-gpu` as a documented rollout-window fallback for
    // modules that predate ui.locality. It is deliberate and commented, and it retires with that
    // window. Naming it here means the sweep above stays honest about what it does not cover.
    const reg = PANEL.find((p) => p.file === "planner-registry.js");
    expect(code(reg!.src)).toContain('"own-gpu"');
  });
});
