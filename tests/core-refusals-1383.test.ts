// vivijure-cf#1383 / #1387: core 1.43.0 throws TYPED refusals for a caller's bad input. The studio must
// answer each as the client error it is, never "internal error" 500.
import { describe, expect, it } from "vitest";
import { ConfigValueError } from "@skyphusion-labs/vivijure-core/modules/registry";
import { BoardKeyCollisionError } from "@skyphusion-labs/vivijure-core/storyboard-projects-db";
import { coreRefusal } from "../src/core-refusals";

describe("coreRefusal", () => {
  it("ConfigValueError (core#343) is a 400 carrying core's sentence", () => {
    const e = new ConfigValueError("resolution", "1080p", ["480p", "720p"]);
    expect(coreRefusal(e)).toEqual({ status: 400, error: e.message });
  });
  it("BoardKeyCollisionError (core#518) is a 409 carrying core's sentence", () => {
    const e = new BoardKeyCollisionError("t", { id: "p1", name: "A", title: "t" } as never);
    expect(coreRefusal(e)).toEqual({ status: 409, error: e.message });
  });
  it("CONTROL: anything else is not a refusal, so the router still answers it 500", () => {
    expect(coreRefusal(new Error("boom"))).toBeNull();
    expect(coreRefusal("nope")).toBeNull();
  });
});
