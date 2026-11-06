/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// cf#1309, the panel half. A standalone clip job row is told apart by its job_id (the list projection
// reads its mode as "full"), labelled "clips", offered one download per finished clip, and NOT offered
// the film actions, whose routes answer 404 or 400 for a clip job. The row script is a classic <script>,
// so it is loaded the way the page loads it: evaluated as one script, its top-level functions read off
// the context. Nothing runs at load, so no DOM is needed for the helpers.

const ROW_JS = readFileSync(`${process.cwd()}/public/planner-history-row.js`, "utf8");
const g: Record<string, unknown> = {};
runInNewContext(ROW_JS + "\n;Object.assign(__out, { isClipJobRow, clipJobDownloads, historyPassLabel });", { __out: g, Map, Set });
const isClipJobRow = g.isClipJobRow as (r: unknown) => boolean;
const clipJobDownloads = g.clipJobDownloads as (r: unknown) => Array<{ shot_id: string; href: string; name: string }>;
const historyPassLabel = g.historyPassLabel as (r: unknown) => string;

const CLIP_ROW = {
  job_id: "clips-00000001-0000-4000-8000-000000000000", project: "harbor", mode: "full", status: "COMPLETED",
  output: { mode: "clips", clips: [{ shot_id: "s1", key: "renders/harbor/clips/s1_wan.mp4" }, { shot_id: "s2" }, null, { shot_id: "s3", key: "" }] },
};
const FILM_ROW = { job_id: "film-00000001-0000-4000-8000-000000000000", project: "harbor", mode: "full", status: "COMPLETED", output: { clips: [{ shot_id: "s1", key: "k" }] } };

describe("cf#1309 a clip job row in render history", () => {
  it("is recognised by its job_id, and a film row is not", () => {
    expect(isClipJobRow(CLIP_ROW)).toBe(true);
    for (const r of [FILM_ROW, { job_id: "scatter-x" }, { job_id: null }, null, {}]) expect(isClipJobRow(r)).toBe(false);
  });
  it("is labelled clips; a film row keeps its own label", () => {
    expect(historyPassLabel(CLIP_ROW)).toBe("clips");
    expect(historyPassLabel(FILM_ROW)).toBe("final");
    expect(historyPassLabel({ ...FILM_ROW, mode: "keyframes-only" })).toBe("preview");
  });
  it("offers one download per finished clip, and skips a clip with no usable key", () => {
    expect(clipJobDownloads(CLIP_ROW)).toEqual([
      { shot_id: "s1", href: "/api/artifact/renders/harbor/clips/s1_wan.mp4", name: "harbor-s1.mp4" },
    ]);
    expect(clipJobDownloads({ ...CLIP_ROW, output: null })).toEqual([]);
  });
  it("gates every film action on the clip-job predicate (source, since the row builder needs a DOM)", () => {
    const build = ROW_JS.slice(ROW_JS.indexOf("function buildHistoryRow"), ROW_JS.indexOf("li.appendChild(actions)"));
    expect(build).toMatch(/if \(!clipJob\) \{\s*const view = document\.createElement/);
    expect(build).toContain("if (cancelable && r.job_id && !clipJob)");
    expect(build).toMatch(/if \(!clipJob\) \{\s*const rerun = document\.createElement/);
    expect(build).toContain("if (isFailed && !clipJob && ");
    expect(build).toContain("clipJob ? clipJobDownloads(r) : []");
    // Delete stays: it is the clip job's only delete path.
    expect(build).toMatch(/const del = document\.createElement\("button"\);/);
  });
});
