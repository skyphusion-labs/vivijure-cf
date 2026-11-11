/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import * as fd from "../public/finish-degrade.js";
import { reportedStages, shotWarningBlocks, stageBlocksFor } from "../public/stage-degrade-view.js";
import type { RenderOutput } from "../public/finish-degrade.js";
import type { StageBlockElement } from "../public/stage-degrade-view.js";
import { parseKeyframes } from "../modules/keyframe/src/keyframe";
import { parseKeyframes as parseLocalGpuKeyframes } from "../modules/local-gpu/src/keyframe";

// cf#916 and cf#1282: the panel tells the user when a render is not clean.
//
// Two signals reached the render payload and nothing in public/ read them:
//   output.content_validation  core 1.25.0: what the clip pixel check measured (cf#916).
//   output.plate_check         core 1.31.0: stills the backend plate count guard could not clean of
//                              an extra person (cf#1282), plus `plate_count` on keyframe entries.
// Both follow the ladder: key ABSENT is "never ran" and shows nothing; a CLEAN result shows nothing;
// only a reported problem renders. The negative direction carries a witness in every case below,
// a sibling signal in the SAME call that DID render, so "nothing rendered" cannot pass by the path
// never being entered.

const ROOT = join(import.meta.dirname, "..");
const { DEGRADE_BANDS, stageBand, stageFrom, stageSummary, stagesNote } = fd;

class El implements StageBlockElement {
  className = "";
  attrs: Record<string, string> = {};
  children: El[] = [];
  _text = "";
  [k: string]: unknown;
  constructor(public tagName: string) {}
  set textContent(v: unknown) { this._text = String(v); }
  get textContent(): string { return this._text; }
  setAttribute(n: string, v: string): void { this.attrs[n] = v; }
  appendChild(c: StageBlockElement): StageBlockElement { this.children.push(c as El); return c; }
  texts(): string[] { return [this._text, ...this.children.flatMap((c) => c.texts())].filter((t) => t.length > 0); }
}
const doc = { createElement: (tag: string) => new El(tag) };
const allText = (els: StageBlockElement[]) => (els as El[]).flatMap((e) => e.texts()).join(" | ");

const UNMEASURED_REASON = "video-finish /inspect unreachable or errored";
const cv = (over: Record<string, unknown> = {}) => ({ checked: 2, unmeasured: 0, reasons: [], ...over });
const plate = (unclean: unknown[], checked = 2) => ({ checked, unclean });
const UNCLEAN = { expected: 2, faces: [3, 3], chosen: 0, clean: false, retries: 1 };
const out = (o: Record<string, unknown>) => ({ output_key: "renders/f/film.mp4", ...o }) as RenderOutput;
// A sibling degrade that DOES render, so a zero-block result for the key under test is a decision.
const WITNESS = { master: { degraded: 1, reasons: ["loudnorm failed"] } };

describe("cf#916 content_validation: the ladder", () => {
  it("ABSENT is unmeasured and renders nothing", () => {
    expect(stageBand(out({}), "content_validation")).toBe(DEGRADE_BANDS.UNMEASURED);
    expect(stageFrom(out({}), "content_validation")).toBeNull();
  });

  it("RAN CLEAN (the measured live shape) is none-reported and renders nothing, beside a witness that does", () => {
    const o = out({ content_validation: cv(), ...WITNESS });
    expect(stageBand(o, "content_validation")).toBe(DEGRADE_BANDS.NONE_REPORTED);
    const blocks = stageBlocksFor(doc, o, fd, {});
    expect(blocks.map((b) => (b as El).attrs["data-stage"])).toEqual(["master"]);
  });

  it("UNMEASURED clips report, with the studio's reason verbatim", () => {
    const o = out({ content_validation: cv({ checked: 0, unmeasured: 5, reasons: [UNMEASURED_REASON] }) });
    expect(stageBand(o, "content_validation")).toBe(DEGRADE_BANDS.REPORTED);
    const info = stageFrom(o, "content_validation")!;
    expect(stageSummary(info)).toBe("5 clips were not checked for picture problems.");
    const text = allText(stageBlocksFor(doc, o, fd, {}));
    expect(text).toContain("5 clips were not checked for picture problems.");
    expect(text).toContain(UNMEASURED_REASON);
  });

  it("a FAILED clip reports by shot, with its reason, and both halves read when both happen", () => {
    const o = out({
      content_validation: cv({
        checked: 3,
        unmeasured: 1,
        reasons: [UNMEASURED_REASON],
        degraded: [{ shot_id: "shot_02", reason: "first frame does not resemble its keyframe" }],
      }),
    });
    const info = stageFrom(o, "content_validation")!;
    expect(info.failed).toBe(1);
    expect(info.unmeasured).toBe(1);
    expect(stageSummary(info)).toBe(
      "1 clip failed the picture check and may look wrong. 1 clip was not checked for picture problems.",
    );
    expect(info.reasons).toEqual(["shot_02: first frame does not resemble its keyframe", UNMEASURED_REASON]);
  });

  it("an unmeasured reason list is not quoted when nothing went unmeasured", () => {
    const info = stageFrom(out({ content_validation: cv({ reasons: ["stale"], degraded: [{ shot_id: "s", reason: "r" }] }) }), "content_validation")!;
    expect(info.reasons).toEqual(["s: r"]);
  });

  it("a shape we do not recognise is UNREADABLE, never clean", () => {
    for (const bad of [{ unmeasured: 0 }, { checked: 1 }, { checked: 1, unmeasured: 0, reasons: "x" }, { checked: -1, unmeasured: 0 }, [], "x"]) {
      expect(stageBand(out({ content_validation: bad }), "content_validation")).toBe(DEGRADE_BANDS.UNREADABLE);
    }
  });
});

describe("cf#1282 plate_check: the ladder", () => {
  it("ABSENT is unmeasured; RAN CLEAN renders nothing beside a witness that does", () => {
    expect(stageBand(out({}), "plate_check")).toBe(DEGRADE_BANDS.UNMEASURED);
    const o = out({ plate_check: plate([]), ...WITNESS });
    expect(stageBand(o, "plate_check")).toBe(DEGRADE_BANDS.NONE_REPORTED);
    expect(stageBlocksFor(doc, o, fd, {}).map((b) => (b as El).attrs["data-stage"])).toEqual(["master"]);
  });

  it("an unclean still reports in plain words, naming the shot and the fix", () => {
    const one = out({ plate_check: plate([{ shot_id: "shot_02", expected: 2, faces: 3 }]) });
    expect(stageBand(one, "plate_check")).toBe(DEGRADE_BANDS.REPORTED);
    expect(allText(stageBlocksFor(doc, one, fd, {}))).toBe(
      "1 still may show an extra person (shot_02). Regenerate that still to try again.",
    );
    const two = out({ plate_check: plate([{ shot_id: "a", expected: 2, faces: 3 }, { shot_id: "b", expected: 2, faces: null }]) });
    expect(stageSummary(stageFrom(two, "plate_check")!)).toBe(
      "2 stills may show an extra person (a, b). Regenerate those stills to try again.",
    );
  });

  it("a shape we do not recognise is UNREADABLE, never clean", () => {
    for (const bad of [{ unclean: [] }, { checked: 1 }, { checked: 1, unclean: {} }, []]) {
      expect(stageBand(out({ plate_check: bad }), "plate_check")).toBe(DEGRADE_BANDS.UNREADABLE);
    }
  });
});

describe("cf#1283 keyframes_incomplete: shots that got no still", () => {
  const kfi = (over: Record<string, unknown> = {}) => ({ adopted: 3, expected: 5, dropped: ["shot_02", "shot_04"], ...over });

  it("ABSENT is unmeasured and renders nothing, beside a witness that does", () => {
    expect(stageBand(out({}), "keyframes_incomplete")).toBe(DEGRADE_BANDS.UNMEASURED);
    const blocks = stageBlocksFor(doc, out({ ...WITNESS }), fd, {});
    expect(blocks.map((b) => (b as El).attrs["data-stage"])).toEqual(["master"]);
  });

  it("a full set (nothing dropped) is none-reported and renders nothing", () => {
    const o = out({ keyframes_incomplete: kfi({ adopted: 5, dropped: [] }), ...WITNESS });
    expect(stageBand(o, "keyframes_incomplete")).toBe(DEGRADE_BANDS.NONE_REPORTED);
    expect(stageBlocksFor(doc, o, fd, {}).map((b) => (b as El).attrs["data-stage"])).toEqual(["master"]);
  });

  it("dropped shots report, named, with how many the film asked for", () => {
    const o = out({ keyframes_incomplete: kfi() });
    expect(stageBand(o, "keyframes_incomplete")).toBe(DEGRADE_BANDS.REPORTED);
    expect(allText(stageBlocksFor(doc, o, fd, {}))).toBe(
      "2 of 5 shots got no still, so this film was made without them (shot_02, shot_04).",
    );
    const one = out({ keyframes_incomplete: kfi({ adopted: 4, dropped: ["shot_05"] }) });
    expect(stageSummary(stageFrom(one, "keyframes_incomplete")!)).toBe(
      "1 of 5 shots got no still, so this film was made without it (shot_05).",
    );
  });

  it("a dropped list that lost its ids still reports from the counts", () => {
    const info = stageFrom(out({ keyframes_incomplete: kfi({ dropped: undefined }) }), "keyframes_incomplete")!;
    expect(info.degraded).toBe(2);
    expect(stageSummary(info)).toBe("2 of 5 shots got no still, so this film was made without them.");
  });

  it("a shape we do not recognise is UNREADABLE, never clean", () => {
    for (const bad of [{ expected: 5, dropped: [] }, { adopted: 3 }, kfi({ dropped: "shot_02" }), kfi({ adopted: -1 }), []]) {
      expect(stageBand(out({ keyframes_incomplete: bad }), "keyframes_incomplete")).toBe(DEGRADE_BANDS.UNREADABLE);
    }
  });

  it("the history badge and the one-screen page say it plainly", () => {
    expect(stagesNote(reportedStages(out({ keyframes_incomplete: kfi() }), fd))!.label).toBe("shots missing");
    expect(fd.simpleWarnings(out({ keyframes_incomplete: kfi() }))).toEqual([
      "Some pictures could not be made, so this video leaves out part of your idea.",
    ]);
    expect(fd.simpleWarnings(out({ keyframes_incomplete: kfi({ adopted: 5, dropped: [] }) }))).toEqual([]);
  });
});

describe("the history badge names the check, not a finishing stage", () => {
  it("one check gets its own short badge; several fall back to the shared label", () => {
    const pc = reportedStages(out({ plate_check: plate([{ shot_id: "a" }]) }), fd);
    expect(stagesNote(pc)!.label).toBe("may show an extra person");
    const c = reportedStages(out({ content_validation: cv({ unmeasured: 1, reasons: ["x"] }) }), fd);
    expect(stagesNote(c)!.label).toBe("picture check");
    const both = reportedStages(out({ plate_check: plate([{ shot_id: "a" }]), content_validation: cv({ unmeasured: 1 }) }), fd);
    expect(stagesNote(both)!.label).toBe("stages limited");
    // An existing stage keeps its old wording exactly.
    expect(stagesNote(reportedStages(out(WITNESS), fd))!.label).toBe("audio master limited");
  });
});

describe("the warning beside one still", () => {
  it("a keyframe entry with clean:false gets the still sentence; clean or unreported gets nothing", () => {
    const o = out({});
    expect(fd.shotWarnings(o, "shot_01", { shot_id: "shot_01", plate_count: UNCLEAN })).toEqual([fd.STILL_EXTRA_PERSON]);
    expect(fd.shotWarnings(o, "shot_01", { shot_id: "shot_01", plate_count: { ...UNCLEAN, clean: true } })).toEqual([]);
    expect(fd.shotWarnings(o, "shot_01", { shot_id: "shot_01" })).toEqual([]);
    expect(fd.shotWarnings(o, "shot_01", { shot_id: "shot_01", plate_count: { clean: "false" } })).toEqual([]);
  });

  it("falls back to output.plate_check when the entry carries no report (an animated film)", () => {
    const o = out({ plate_check: plate([{ shot_id: "shot_02", expected: 2, faces: 3 }]) });
    expect(fd.shotWarnings(o, "shot_02", { shot_id: "shot_02" })).toEqual([fd.STILL_EXTRA_PERSON]);
    expect(fd.shotWarnings(o, "shot_01", { shot_id: "shot_01" })).toEqual([]);
  });

  it("a clip that failed the picture check is flagged on its own shot only", () => {
    const o = out({ content_validation: cv({ degraded: [{ shot_id: "shot_03", reason: "noise" }] }) });
    expect(fd.shotWarnings(o, "shot_03", null)).toEqual(["This clip failed the picture check and may look wrong."]);
    expect(fd.shotWarnings(o, "shot_01", null)).toEqual([]);
  });

  it("shotWarningBlocks paints them, and paints nothing for a clean shot in the same render", () => {
    const o = out({ plate_check: plate([{ shot_id: "shot_02" }]) });
    const bad = shotWarningBlocks(doc, o, "shot_02", { shot_id: "shot_02" }, fd, { className: "w" }) as El[];
    expect(bad.map((e) => [e.tagName, e.className, e.attrs.role, e.attrs["data-shot-id"], e.textContent])).toEqual([
      ["p", "w", "note", "shot_02", fd.STILL_EXTRA_PERSON],
    ]);
    expect(shotWarningBlocks(doc, o, "shot_01", { shot_id: "shot_01" }, fd)).toEqual([]);
  });

  it("the still sentence has no dashes and says what to do", () => {
    expect(fd.STILL_EXTRA_PERSON).toBe("This still may show an extra person. Regenerate it to try again.");
  });
});

describe("the one-screen Make a video page", () => {
  it("plain lines, no shot ids, nothing for a clean or unchecked video", () => {
    expect(fd.simpleWarnings(out({}))).toEqual([]);
    expect(fd.simpleWarnings(out({ content_validation: cv(), plate_check: plate([]) }))).toEqual([]);
    expect(fd.simpleWarnings(out({
      content_validation: cv({ unmeasured: 1, reasons: ["x"], degraded: [{ shot_id: "s", reason: "r" }] }),
      plate_check: plate([{ shot_id: "shot_02" }]),
    }))).toEqual([
      "Some clips failed the picture check and may look wrong.",
      "Some clips could not be checked for picture problems.",
      "One picture may show an extra person. To fix it, open the advanced planner and regenerate that picture.",
    ]);
    expect(fd.simpleWarnings(out({ plate_check: plate([{ shot_id: "a" }, { shot_id: "b" }]) }))).toEqual([
      "2 pictures may show an extra person. To fix them, open the advanced planner and regenerate those pictures.",
    ]);
  });

  it("make.js renders every line, and make.html has a box for several", () => {
    const js = readFileSync(join(ROOT, "public/make.js"), "utf8");
    expect(js).toContain("notes.push(...fd.simpleWarnings(out));");
    const html = readFileSync(join(ROOT, "public/make.html"), "utf8");
    expect(html).toContain('<div id="make-result-note" class="make-notes" role="note" hidden></div>');
  });
});

describe("cf#1282: the keyframe modules pass the backend report through", () => {
  const result = { keyframes: [{ shot_id: "shot_01", key: "k1.png", plate_count: UNCLEAN }, { shot_id: "shot_02", key: "k2.png" }, { shot_id: "shot_03", key: "k3.png", plate_count: [1] }] };
  it("own GPU keyframe module", () => {
    expect(parseKeyframes({ output: result })).toEqual([
      { shot_id: "shot_01", keyframe_key: "k1.png", plate_count: UNCLEAN },
      { shot_id: "shot_02", keyframe_key: "k2.png" },
      { shot_id: "shot_03", keyframe_key: "k3.png" },
    ]);
  });
  it("local GPU module", () => {
    expect(parseLocalGpuKeyframes({ output: result })).toEqual([
      { shot_id: "shot_01", keyframe_key: "k1.png", plate_count: UNCLEAN },
      { shot_id: "shot_02", keyframe_key: "k2.png" },
      { shot_id: "shot_03", keyframe_key: "k3.png" },
    ]);
  });
});

describe("the planner history strip asks for the warnings of every still", () => {
  it("planner-history-row.js paints shotWarningBlocks under each keyframe", () => {
    const src = readFileSync(join(ROOT, "public/planner-history-row.js"), "utf8");
    expect(src).toContain("window.stageDegradeView.shotWarningBlocks(document, r.output, kf.shot_id, kf, window.finishDegrade, {");
    expect(src).toContain("for (const w of shotWarns) wrap.appendChild(w);");
  });
});

describe("cf#1282: a retake drops the report of the still it replaced", () => {
  it("the retake keyframe map deletes plate_count only where a new still lands", () => {
    const src = readFileSync(join(ROOT, "src/studio.ts"), "utf8");
    expect(src).toContain("const next = retake.stills?.[k.shot_id];\n          if (!next) return k;");
    expect(src).toContain("delete copy.plate_count;");
  });
});

// THE RATCHET cf#916 asked for. Every key the core writes onto a finished render's payload must have
// a READER in public/ or a stated exemption. A key added later with neither fails here, instead of
// being found by hand on a live render months later (which is how cf#860 and cf#916 were found).
//
// "Reader" means the key appears as a property access (`.key`) or a quoted string in the CODE of a
// public/*.js file, with comments stripped first: a comment naming a key is not a reader, and
// measured while writing this, a comment alone kept the ratchet green with the real reader removed.
// It is still a mention, not proof of a caller, so it can pass a key that is used and never
// rendered; it cannot pass a key no code touches, which is the failure it exists for. The core list
// is read from the INSTALLED core's dist, so it follows the pin rather than a hand-typed copy.
// EMPTY since cf#1283 gave keyframes_incomplete its reader. An entry needs a reason and an issue.
const EXEMPT: Record<string, string> = {};

function corePayloadKeys(): string[] {
  const dist = join(ROOT, "node_modules/@skyphusion-labs/vivijure-core/dist/render-output-payload.js");
  const src = readFileSync(dist, "utf8");
  return [...new Set([...src.matchAll(/\bout\.([a-z_]+)\s*=/g)].map((m) => m[1]))].sort();
}

/** Block comments, then line comments that start a line or follow whitespace (so a `//` inside a
 *  URL string such as "https://x" is left alone). Coarse on purpose; see the positive control. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function panelSource(): string {
  const dir = join(ROOT, "public");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => stripComments(readFileSync(join(dir, f), "utf8")))
    .join("\n");
}

const hasReader = (src: string, key: string) =>
  new RegExp("\\." + key + "\\b|[\"']" + key + "[\"']").test(src);

describe("ratchet: no render payload key without a panel reader or an exemption", () => {
  const keys = corePayloadKeys();
  const src = panelSource();

  it("the instrument reads the core payload builder (positive control)", () => {
    // If the dist moves or the pattern stops matching, the loop below would pass on an empty list.
    expect(keys).toEqual(expect.arrayContaining(["content_validation", "film_finish", "keyframes_incomplete"]));
    expect(keys.length).toBeGreaterThan(10);
  });

  it("the reader test can say no (negative control)", () => {
    // A key no code could ever read. Until cf#1283 the live control was keyframes_incomplete itself.
    expect(hasReader(src, "no_such_payload_key")).toBe(false);
    expect(hasReader(stripComments("// output.no_such_payload_key\n/* \"no_such_payload_key\" */"), "no_such_payload_key")).toBe(false);
    expect(hasReader(src, "film_finish")).toBe(true);
  });

  for (const key of corePayloadKeys()) {
    it(key, () => {
      if (EXEMPT[key]) {
        // An exemption that has gained a reader is stale: remove it so the list cannot grow a graveyard.
        expect(hasReader(src, key), `${key} is exempt but now has a reader; drop the exemption`).toBe(false);
        return;
      }
      expect(hasReader(src, key), `${key} is on the render payload and nothing in public/ reads it`).toBe(true);
    });
  }
});
