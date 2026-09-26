import { describe, it, expect } from "vitest";
import { resolveCastLoras } from "@skyphusion-labs/vivijure-core/cast-loras";
import { orch } from "./orchestrator-env";

describe("resolveCastLoras", () => {
  it("returns empty when castLoras is missing", async () => {
    const env = {} as import("../src/env").Env;
    const r = await resolveCastLoras(orch(env), undefined);
    expect(r.pretrained).toEqual({});
    expect(r.skipped).toEqual([]);
  });
});
