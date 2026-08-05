// Dual-panel of local#278: self-host local-gpu is hobby/non-commercial; commercial is vivijure-cf.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "modules/local-gpu/src/index.ts");

describe("local-gpu cost honesty (local#278)", () => {
  it("does not claim Free after hardware and points commercial use at vivijure-cf", () => {
    const raw = readFileSync(SRC, "utf8");
    expect(raw).not.toMatch(/Free after hardware/);
    expect(raw).toMatch(/non-commercial|hobby/i);
    expect(raw).toMatch(/vivijure-cf/);
    expect(raw).toMatch(/CogVideoX|self-host/i);
  });
});
