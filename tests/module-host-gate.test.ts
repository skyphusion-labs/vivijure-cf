/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  VIDEO_FINISH_GATED_HOOKS,
  VIDEO_FINISH_CAPABILITY_KEY,
} from "../src/video-finish-availability";

// THE MODULE-HOST PAGE IS PART OF THE PROJECTION, NOT AN EXCEPTION TO IT (cf#234 item 3).
//
// modules.html is the one studio surface whose entire job is to state what this host can do: it
// renders a stage per catalog hook and each installed module under the stage it serves. Every stage
// card app.js builds has declared `data-hook` since the page was written -- and the cf#98
// availability gate was never loaded on that page, so the declarations sat inert and a studio with
// no video-finish tier presented its dead stages as ordinary live ones.
//
// `notify` is the sharp end. It is deliberately skipped from the planner panel, it has no planner
// control at all, and the "enable notifications" toggle is NOT it (that is the browser Notification
// API, and gating it would grey out a feature that works -- guarded in hook-declarations.test.ts).
// So the stage projection is the ONLY surface in the studio where an unservable `notify` can be
// disclosed at all. If this file goes quiet, that disclosure has gone silent with it.
//
// These are asset guards over the SHIPPED files: they prove the wiring decision, not the rendering.
// The rendering is proven twice over -- against the real gate IIFE in hook-availability-gate.test.ts
// (a stage-card-shaped fixture), and in a browser against a real host payload before release.
//
// Every negative below is paired with a POSITIVE CONTROL, because an assertion over a file that has
// been renamed, moved, or emptied passes without proving anything.

const modulesHtml = readFileSync("public/modules.html", "utf8");
const plannerHtml = readFileSync("public/planner.html", "utf8");
const appJs = readFileSync("public/app.js", "utf8");

const GATE_ASSETS = ["hook-availability-checks.js", "hook-availability.js"];

/** Whole-line `//` comments. The comments here DISCUSS the wrong shapes in order to explain why
 *  they are wrong, and a naive text match reads those as the defect they warn about. Line-scoped,
 *  so there is no multi-character delimiter to half-remove (see hook-declarations.test.ts). */
function code(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/** The body of `function renderPipeline(...)`, up to its closing brace at column 0. */
function renderPipelineBody(src: string): string {
  const at = src.indexOf("function renderPipeline(");
  expect(at, "app.js has no renderPipeline; this file cannot assert anything about it").toBeGreaterThan(-1);
  const end = src.indexOf("\n}", at);
  expect(end, "renderPipeline is not closed at column 0").toBeGreaterThan(at);
  return src.slice(at, end);
}

/** Index of a `<script src="NAME">` tag, or -1. Order matters, so this returns a position. */
function scriptAt(html: string, name: string): number {
  return html.indexOf('<script src="' + name + '"');
}

describe("CONTROL: the reader finds gate assets on a page that already loads them", () => {
  it("planner.html loads both gate assets, so a miss below is a real miss", () => {
    // Without this, "modules.html loads the gate" could be passing on a broken matcher.
    for (const asset of GATE_ASSETS) {
      expect(scriptAt(plannerHtml, asset), "planner.html should load " + asset).toBeGreaterThan(-1);
    }
    expect(scriptAt(plannerHtml, "a-file-that-does-not-exist.js")).toBe(-1);
  });
});

describe("cf#234: the module-host page loads the availability gate", () => {
  it("modules.html ships both gate assets", () => {
    for (const asset of GATE_ASSETS) {
      expect(
        scriptAt(modulesHtml, asset),
        asset + " is not loaded on modules.html; every stage declaration on that page is inert",
      ).toBeGreaterThan(-1);
    }
  });

  it("loads them before app.js, so the gate is on window before the projection boots", () => {
    const app = scriptAt(modulesHtml, "app.js");
    expect(app).toBeGreaterThan(-1);
    for (const asset of GATE_ASSETS) {
      const at = scriptAt(modulesHtml, asset);
      // Presence FIRST. A missing asset scores -1, which is less than every real index, so an
      // ordering check alone passes loudest exactly when the asset is not there at all (caught by
      // deliberately deleting both tags: this assertion stayed green until the line below existed).
      expect(at, asset + " is not loaded at all").toBeGreaterThan(-1);
      expect(at, asset + " must precede app.js").toBeLessThan(app);
    }
  });
});

describe("cf#234: the stage projection declares generically and re-gates what it builds", () => {
  it("every stage card carries its hook in CONTAINER scope", () => {
    const src = code(appJs);
    expect(src).toMatch(/card\.dataset\.hook\s*=\s*hook\.name/);
    expect(
      src,
      "without container scope a dead stage still takes input into knobs that will never run",
    ).toMatch(/card\.dataset\.hookScope\s*=\s*"container"/);
  });

  it("re-applies the gate after building the pipeline, hung off ready so ordering cannot lose", () => {
    const src = code(appJs);
    // The cards are built after an await; the gate sweeps the document when ITS OWN read resolves.
    // A bare apply() here silently does nothing on the ordering where the map is not populated yet.
    // Read the CALL SITE, not the file. `function applyHookGate(root)` contains the same text as a
    // call to it, so a whole-file match stayed green with the call deleted from renderPipeline
    // (found by deleting it). Scope to the function body that must make the call.
    const body = renderPipelineBody(src);
    expect(body, "renderPipeline builds the cards; it must re-gate them").toContain(
      "applyHookGate(root)",
    );
    expect(src, "a bare apply() loses the race in one direction").toMatch(
      /gate\.ready[\s\S]{0,160}gate\.apply\(root\)/,
    );
  });

  it("names NO hook of its own: the availability answer comes from the host, never from here", () => {
    // The house rule the whole page is built on. A per-hook branch here would be the hardcoded
    // section this repo refuses, and it would strand the next key the host learns to report.
    const src = code(appJs);
    for (const hook of [...VIDEO_FINISH_GATED_HOOKS, VIDEO_FINISH_CAPABILITY_KEY]) {
      expect(src, "app.js must not know the name " + hook).not.toContain(hook);
    }
    // CONTROL for the line above: the reader can see literals in this file when they exist.
    expect(src).toContain("stage");
  });
});
