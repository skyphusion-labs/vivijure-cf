/// <reference types="node" />
// cf#844: keep the control-plane doc's arithmetic true, because its whole argument rests on it.
//
// `docs/containers-control-plane.md` makes a second-instrument argument that does not consult the
// Containers API about its own reliability: current code can only mint the pool name `sync-0`, because
// `poolIndex()` is `Math.floor(Math.random() * SYNC_POOL_SIZE)` and `SYNC_POOL_SIZE` is 1; the live
// instances list contains `sync-3`; therefore those records predate the current configuration and the
// list is historical.
//
// **That argument is only valid while SYNC_POOL_SIZE is actually 1.** Raise the pool to 4 and `sync-3`
// becomes a name current code can mint, the inference silently inverts, and the doc goes on asserting
// it. That is the comment-asserting-a-property-the-code-lacks defect, which this repo has spent a
// sprint clearing, and shipping a doc without this guard would have been a fresh instance of it.
//
// So: the number in the doc is DERIVED from the source here, not trusted.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = "src/video-finish-binding.ts";
const DOC = "docs/containers-control-plane.md";

const src = readFileSync(SRC, { encoding: "utf8" });
const doc = readFileSync(DOC, { encoding: "utf8" });

describe("cf#844: the control-plane doc cannot drift from the pool arithmetic it argues from", () => {
  it("HARNESS: SYNC_POOL_SIZE parses out of the source as a positive integer", () => {
    // Without this floor a failed parse yields NaN and every comparison below passes or fails for the
    // wrong reason.
    const m = /export const SYNC_POOL_SIZE = (\d+);/.exec(src);
    expect(m, `could not find SYNC_POOL_SIZE in ${SRC}`).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  });

  it("the doc quotes the REAL SYNC_POOL_SIZE", () => {
    const size = Number(/export const SYNC_POOL_SIZE = (\d+);/.exec(src)![1]);
    expect(doc, `${DOC} must quote SYNC_POOL_SIZE = ${size}, the value in ${SRC}`)
      .toContain(`SYNC_POOL_SIZE = ${size}`);
  });

  it("the doc's sync-N argument still holds: the cited name is one current code CANNOT mint", () => {
    const size = Number(/export const SYNC_POOL_SIZE = (\d+);/.exec(src)![1]);
    // poolIndex is floor(random * SYNC_POOL_SIZE), so the mintable names are sync-0 .. sync-(size-1).
    // The doc's argument requires the name it cites to be OUTSIDE that range.
    const cited = [...doc.matchAll(/`sync-(\d+)`/g)].map((m) => Number(m[1]));
    expect(cited.length, "the doc must cite at least one sync-N name for its argument").toBeGreaterThan(0);
    const highest = Math.max(...cited);
    expect(
      highest,
      `the doc argues from sync-${highest}, but SYNC_POOL_SIZE is ${size}, so current code CAN mint it `
        + `and the inference is no longer valid. Update the doc's argument, not this test.`,
    ).toBeGreaterThanOrEqual(size);
  });

  it("the doc still says what the endpoint cannot prove, in the words the issue settled on", () => {
    // The one sentence cf#844 asked to be standing guidance. If a future edit smooths it away, the
    // doc keeps its measurements and loses its point.
    expect(doc).toMatch(/the endpoint reported nothing/);
    expect(doc).toMatch(/not "nothing is running"|not as "nothing is running"|and not "nothing is running"/);
  });

  it("the doc is not a stub", () => {
    expect(doc.split("\n").length).toBeGreaterThan(40);
    expect(doc).toContain("There is no `started_at` field");
  });
});
