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
//
// SCANNED, NOT REGEX-REPLACED, and the reason is the same defect one door down. A single-pass
// `replace(/<!--[\s\S]*?-->/g, "")` can leave a residual `<!--` behind (CodeQL
// js/incomplete-multi-character-sanitization, raised HIGH on the first version of this file), and a
// comment fragment that survives stripping can still satisfy or mask an assertion here -- which is
// exactly the failure this whole helper exists to prevent. A scanner cannot leave residue: it walks
// the text and copies only what is outside a comment.
//
// UNTERMINATED comment: everything after it is treated as comment and dropped. That direction is
// deliberate. It can only ever REMOVE text, never invent it, so the risk it carries is a negative
// assertion passing on an over-stripped file -- and the CONTROL describe below fails loudly on
// exactly that, because it asserts the declarations that DO ship are still found.
function stripHtmlComments(src: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const open = src.indexOf("<!--", i);
    if (open < 0) return out + src.slice(i);
    out += src.slice(i, open);
    const close = src.indexOf("-->", open + 4);
    if (close < 0) return out;
    i = close + 3;
  }
}

/** Whole-line `//` comments. Line-scoped, so there is no multi-character delimiter to half-remove. */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function code(src: string): string {
  return stripLineComments(stripHtmlComments(src));
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

describe("the comment stripper itself, because every assertion here trusts it", () => {
  // A sanitizer nobody tests is a sanitizer nobody knows the shape of. These are the inputs that
  // broke the regex version.
  it("leaves NO residual comment OPENER, even on nested and adjacent markers", () => {
    // The CodeQL finding is a surviving `<!--`: an un-stripped opener can hide shipped text from
    // the assertions below, or let commented text be read as shipped. That is what must be zero.
    //
    // A trailing `-->` DOES survive here, and it should. HTML comments do not nest: the browser
    // ends this comment at the FIRST `-->`, so the trailing ` -->` is literal document text, not a
    // comment fragment. This helper answers "what ships to the browser", so it has to agree with
    // the browser. My first version of this assertion forbade any surviving delimiter and failed on
    // that input -- the assertion was wrong, not the scanner, and it is written down here because
    // the next person will have the same instinct.
    const nasty = '<!-- <!-- data-hook="score" --> --><input id="a" data-hook="keyframe" />';
    const out = code(nasty);
    expect(out, "a surviving <!-- is the CodeQL finding").not.toContain("<!--");
    expect(out, "commented-out declarations must not survive").not.toContain('data-hook="score"');
    expect(out, "and real markup after the comment still ships").toContain('data-hook="keyframe"');
  });

  it("removes what is INSIDE a comment and keeps what ships", () => {
    const src = '<!-- data-hook="score" is wrong here --><input id="real" data-hook="film.finish" />';
    expect(code(src)).not.toContain('data-hook="score"');
    expect(code(src)).toContain('data-hook="film.finish"');
  });

  it("drops whole-line // comments without touching code on its own line", () => {
    const src = '  // el.dataset.hook = "score";\nel.dataset.hook = "capability:video-finish";';
    expect(code(src)).not.toContain('"score"');
    expect(code(src)).toContain("capability:video-finish");
  });

  it("an UNTERMINATED comment drops the rest rather than leaking a fragment", () => {
    const out = code('<input id="kept" /><!-- data-hook="score" and no close');
    expect(out).toContain('id="kept"');
    expect(out).not.toContain("<!--");
    expect(out).not.toContain('data-hook="score"');
  });
});

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
