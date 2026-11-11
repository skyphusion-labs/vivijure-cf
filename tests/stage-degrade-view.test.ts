/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import * as fd from "../public/finish-degrade.js";
import { reportedStages, stageBlocks, stageBlocksFor } from "../public/stage-degrade-view.js";
import type { RenderOutput, StageDegrade } from "../public/finish-degrade.js";
import type { StageBlockElement } from "../public/stage-degrade-view.js";

// PAINTING COVERAGE (cf#864). Everything before this asserted the DECIDING -- 74 cases over the
// parse and the bands -- while nothing asserted that any of it reached the screen. Both host
// functions are unreachable from a unit test (buildHistoryRow is ~980 lines over ~40 sibling
// helpers; renderDegradeNote resolves live DOM through `$()`), so cf#864 pulled the construction
// into stage-degrade-view.js and this file drives THAT.
//
// THE ASSERTION THAT MATTERS IS THE NEGATIVE ONE: a clean stage and a never-reached stage must
// render NOTHING. A block that appears on a healthy render is worse than none, because people
// learn to ignore it and then it reads as coverage.
//
// AND A NEGATIVE ASSERTION IS THE EASIEST KIND TO MAKE HOLLOW. "No block rendered" is the expected
// outcome, so it passes just as happily when the enumeration was never entered as when it ran and
// correctly declined. Those are different facts. Every zero-block case below therefore carries a
// WITNESS that the path executed: either a spy recording which stage keys were actually asked for,
// or a sibling stage in the SAME call that DID render. Without one of those, these tests would be
// the exact shape they exist to prevent.

// ---- minimal element stub (no jsdom; matches the repo's Node-env test pattern) ---------------
class El implements StageBlockElement {
  tagName: string;
  className = "";
  attrs: Record<string, string> = {};
  children: El[] = [];
  _text = "";
  [k: string]: unknown;
  constructor(tag: string) {
    this.tagName = tag;
  }
  set textContent(v: unknown) {
    this._text = String(v);
  }
  get textContent(): string {
    return this._text;
  }
  setAttribute(n: string, v: string): void {
    this.attrs[n] = v;
  }
  appendChild(c: StageBlockElement): StageBlockElement {
    this.children.push(c as El);
    return c;
  }
  /** Every descendant's text, so a reason can be found wherever in the block it sits. */
  texts(): string[] {
    return [this._text, ...this.children.flatMap((c) => c.texts())].filter((t) => t.length > 0);
  }
}

function factory() {
  const made: El[] = [];
  return {
    made,
    doc: {
      createElement(tag: string): El {
        const e = new El(tag);
        made.push(e);
        return e;
      },
    },
  };
}

/** finishDegrade, wrapped so we can SEE which stage keys the enumeration asked for. */
function spyFd() {
  const asked: string[] = [];
  return {
    asked,
    fd: {
      STAGE_KEYS: fd.STAGE_KEYS,
      stageFrom(output: RenderOutput | null | undefined, key: string) {
        asked.push(key);
        return fd.stageFrom(output, key as never);
      },
      stageSummary: fd.stageSummary,
    },
  };
}

const REPORTED_SPEECH = {
  speech: { degraded: 2, reasons: ["speech module MODULE_SPEECH not bound"] },
} as unknown as RenderOutput;

describe("cf#864 a reported stage is actually painted", () => {
  it("builds one block carrying our summary AND the reason VERBATIM", () => {
    const { made, doc } = factory();
    const els = stageBlocksFor(doc, REPORTED_SPEECH, fd, { className: "x", role: "note" }) as El[];
    expect(els).toHaveLength(1);
    expect(els[0].attrs["data-stage"]).toBe("speech");
    expect(els[0].attrs.role).toBe("note");
    expect(els[0].className).toBe("x");
    const texts = els[0].texts();
    // OUR structural sentence, counting shots not distinct reasons (degraded 2, reasons 1).
    expect(texts.some((t) => t.includes("2 shots"))).toBe(true);
    // The studio's words, unrewritten.
    expect(texts).toContain("speech module MODULE_SPEECH not bound");
    expect(made.length).toBeGreaterThan(0);
  });

  it("paints film_finish, which is LIVE on the installed core today", () => {
    const out = {
      film_finish: { applied: [], adopted: [], degraded: "film-titles: not bound; shipped uncarded" },
    } as unknown as RenderOutput;
    const els = stageBlocksFor(factory().doc, out, fd, {}) as El[];
    expect(els).toHaveLength(1);
    expect(els[0].attrs["data-stage"]).toBe("film_finish");
    expect(els[0].texts()).toContain("film-titles: not bound; shipped uncarded");
  });

  it("one block PER stage, never merged into one sentence", () => {
    const out = {
      speech: { degraded: 1, reasons: ["a"] },
      master: { degraded: 1, reasons: ["b"] },
    } as unknown as RenderOutput;
    const els = stageBlocksFor(factory().doc, out, fd, {}) as El[];
    expect(els).toHaveLength(2);
    expect(els.map((e) => e.attrs["data-stage"])).toEqual(["speech", "master"]);
  });
});

describe("cf#864 THE NEGATIVE DIRECTION, with a witness that the path ran", () => {
  it("a CLEAN stage renders nothing -- and the enumeration is proven to have asked for it", () => {
    const { asked, fd: spy } = spyFd();
    const { made, doc } = factory();
    const clean = {
      speech: { degraded: 0, reasons: [] },
      master: { degraded: 0, reasons: [] },
      dialogue: { degraded: 0, reasons: [] },
      film_finish: { applied: ["titles"], adopted: [], degraded: null },
    } as unknown as RenderOutput;

    const els = stageBlocksFor(doc, clean, spy, {});

    // THE WITNESS: every declared stage was actually interrogated. Without this, "0 blocks" is
    // indistinguishable from an enumeration that never ran.
    expect(asked).toEqual(fd.STAGE_KEYS);
    // THE ASSERTION: it ran, it looked at all four, and it declined to paint.
    expect(els).toHaveLength(0);
    // Nothing was even constructed, so no empty shell can leak into the DOM.
    expect(made).toHaveLength(0);
  });

  it("an ABSENT stage renders nothing, same witness", () => {
    const { asked, fd: spy } = spyFd();
    const { made, doc } = factory();
    const els = stageBlocksFor(doc, { output_key: "renders/film-x/film.mp4" } as RenderOutput, spy, {});
    expect(asked).toEqual(fd.STAGE_KEYS);
    expect(els).toHaveLength(0);
    expect(made).toHaveLength(0);
  });

  it("the STRONGEST form: one reported stage beside three that are not, in ONE call", () => {
    // The sibling that DOES render is the witness here -- the loop demonstrably reached the
    // building step and still emitted nothing for the other three. This is the case that a
    // never-entered enumeration cannot fake.
    const mixed = {
      speech: { degraded: 1, reasons: ["speech degraded"] },
      master: { degraded: 0, reasons: [] },
      film_finish: { applied: [], adopted: [], degraded: null },
    } as unknown as RenderOutput;
    const els = stageBlocksFor(factory().doc, mixed, fd, {}) as El[];
    expect(els).toHaveLength(1);
    expect(els[0].attrs["data-stage"]).toBe("speech");
    expect(els[0].texts()).toContain("speech degraded");
  });

  it("an UNREADABLE stage paints no prose (there is nothing readable to quote)", () => {
    const out = { master: { degraded: "lots", reasons: "nope" } } as unknown as RenderOutput;
    // The band is "unreadable" and gets a badge and a data attribute elsewhere; inventing a cause
    // here is the one thing this projection must never do.
    expect(fd.stageBand(out, "master")).toBe(fd.DEGRADE_BANDS.UNREADABLE);
    expect(stageBlocksFor(factory().doc, out, fd, {})).toHaveLength(0);
  });
});

describe("cf#864 the builder is total in one direction only", () => {
  it("a junk entry is skipped without hiding the stages that DID report", () => {
    const infos = [
      null,
      { stage: "speech", degraded: 1, reasons: ["real"] },
      { stage: "", degraded: 1, reasons: ["no stage"] },
    ] as unknown as StageDegrade[];
    const els = stageBlocks(factory().doc, infos, fd.stageSummary, {}) as El[];
    expect(els).toHaveLength(1);
    expect(els[0].attrs["data-stage"]).toBe("speech");
  });

  it("no summary and no reasons emits no empty shell", () => {
    const infos = [{ stage: "speech", degraded: 0, reasons: [] }] as unknown as StageDegrade[];
    expect(stageBlocks(factory().doc, infos, () => null, {})).toHaveLength(0);
  });

  it("a missing doc or a missing finishDegrade degrades to nothing rather than throwing", () => {
    expect(stageBlocks(null, [], null, {})).toEqual([]);
    expect(stageBlocks({} as never, [], null, {})).toEqual([]);
    expect(reportedStages(REPORTED_SPEECH, null)).toEqual([]);
    expect(reportedStages(REPORTED_SPEECH, { STAGE_KEYS: [] } as never)).toEqual([]);
    expect(stageBlocksFor(factory().doc, REPORTED_SPEECH, null, {})).toEqual([]);
  });
});

describe("cf#864 there is exactly ONE place a stage degrade becomes DOM", () => {
  // cf#853 wrote this loop into two files. The ratchet is on the ABSENCE of a third copy: when the
  // remedy is removing a duplicate, the durable assertion is that it does not come back, or the
  // deletion decays with nothing noticing.
  const PUB = join(import.meta.dirname, "..", "public");

  it("only stage-degrade-view.js constructs a stage block", () => {
    const owners: string[] = [];
    for (const f of readdirSync(PUB).filter((n) => n.endsWith(".js"))) {
      const src = readFileSync(join(PUB, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (src.includes('"data-stage"')) owners.push(f);
    }
    expect(owners, "a second file builds stage blocks again").toEqual(["stage-degrade-view.js"]);
  });

  it("both consumers go through the shared seam", () => {
    const read = (f: string) => readFileSync(join(PUB, f), "utf8");
    expect(read("planner-render.js")).toContain("stageDegradeView.stageBlocksFor(");
    expect(read("planner-render.js")).toContain("stageDegradeView.reportedStages(");
    expect(read("planner-history-row.js")).toContain("stageDegradeView.stageBlocks(");
    expect(read("planner-history-row.js")).toContain("stageDegradeView.reportedStages(");
  });

  it("the page loads it (a module nothing loads is a module nothing runs)", () => {
    expect(readFileSync(join(PUB, "planner.html"), "utf8")).toContain('src="stage-degrade-view.js"');
  });
});
