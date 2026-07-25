/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// WHAT EACH SHIPPED CONTROL DECLARES (cf#229 / cf#234).
//
// The cf#98 gate is generic and knows nothing about features; ALL of the per-feature judgement lives
// in one attribute per control. That makes the attributes the contract, and an attribute is exactly
// the kind of thing a fast tidy-up moves. These assertions read the SHIPPED assets and forbid the
// three named failures, none of which any other test in the repo can see:
//
//   1. re-declaring a bed generator as requiring "score"          -> greys out a control that works
//   2. gating the notification TOGGLE on the "notify" hook        -> greys out a control that works
//   3. a mux button losing its declaration                        -> a button that 422s on click
//
// Every negative here is paired with a POSITIVE CONTROL, because a negative assertion over an asset
// that is missing, renamed, or unreadable passes without proving anything.

const html = readFileSync("public/planner.html", "utf8");
const historyRow = readFileSync("public/planner-history-row.js", "utf8");
const renderConfig = readFileSync("public/planner-render-config.js", "utf8");

// A guard must forbid the DECLARATION, not the mention of one. Both files carry comments that
// discuss the wrong declaration in order to explain why it is wrong (that is the point of the
// comments), and a naive text match reads those as the defect they warn about -- caught by this
// suite on its first run. Strip comments, then assert against what actually ships to the browser.
function code(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CAPABILITY = "capability:video-finish";

/** The markup of the single element carrying this id, up to the end of its opening tag. */
function openingTag(source: string, id: string): string {
  const at = source.indexOf('id="' + id + '"');
  expect(at, "element #" + id + " not found; this file cannot assert anything about it").toBeGreaterThan(-1);
  const start = source.lastIndexOf("<", at);
  const end = source.indexOf(">", at);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 1);
}

describe("CONTROL: the reader actually finds declarations where they exist", () => {
  // Without this, every "does not declare" assertion below would pass on an empty string.
  it("finds the declarations that DO ship", () => {
    expect(openingTag(html, "planner-film-title")).toContain('data-hook="film.finish"');
    expect(openingTag(html, "planner-model")).toContain('data-hook="plan.enhance"');
  });
});

describe("cf#229: bed GENERATION is advisory, never required", () => {
  it("the music and narration blocks declare the capability ADVISORILY", () => {
    for (const id of ["planner-music-gen-block", "planner-narration-gen-block"]) {
      const tag = openingTag(html, id);
      expect(tag, id).toContain('data-hook-advisory="' + CAPABILITY + '"');
      // The failure: promoting the advisory to a requirement, which disables a generator that works.
      expect(tag, id).not.toMatch(/data-hook=/);
    }
  });

  it("NOTHING in the shipped panel requires the score hook", () => {
    // cf#229 in one line. score is servable on a studio with no video-finish tier, so a required
    // declaration on it is an over-claim wherever it appears.
    for (const [name, src] of [["planner.html", html], ["planner-history-row.js", historyRow]] as const) {
      expect(code(src), name).not.toMatch(/data-hook="score"/);
      expect(code(src), name).not.toMatch(/dataset\.hook = "score"/);
    }
  });
});

describe("cf#118/#229: the mux buttons declare the capability they actually need", () => {
  it("add-audio and narrate both gate on the video-finish capability", () => {
    const declared = code(historyRow).match(/dataset\.hook = "([^"]+)"/g) ?? [];
    expect(declared.length, "the two mux buttons must still declare something").toBe(2);
    for (const d of declared) expect(d).toContain(CAPABILITY);
  });
});

describe("cf#234: the notification TOGGLE is not the notify HOOK", () => {
  it("#planner-notify-toggle declares NOTHING, and that is deliberate", () => {
    // The trap, stated so it survives the next person greping for "notify": the toggle is the
    // browser Notification API (planner-init.js), pure client-side, and it works perfectly on a
    // studio with no video-finish tier. The notify HOOK never firing there is a separate, true
    // fact. Tagging this control would grey out something that works -- the same dishonesty as a
    // broken button, pointed the other way.
    const tag = openingTag(html, "planner-notify-toggle");
    expect(tag).not.toMatch(/data-hook/);
  });
});

describe("cf#234: projected module sections gate generically", () => {
  it("renderModuleSection declares the hook it was rendered under, in container scope", () => {
    // The generic half: one declaration per projected section covers master, film.finish, notify,
    // and any hook added later, with no per-feature branch anywhere.
    expect(renderConfig).toMatch(/details\.dataset\.hook = hook/);
    expect(renderConfig).toMatch(/details\.dataset\.hookScope = "container"/);
    // Rendered under the hook it belongs to, NOT mod.hooks[0]: a multi-hook module would otherwise
    // be gated on a sibling capability its section does not use.
    expect(renderConfig).toMatch(/renderModuleSection\(mod, h\.hook\)/);
  });
});
