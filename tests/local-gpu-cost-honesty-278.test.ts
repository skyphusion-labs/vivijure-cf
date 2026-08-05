// Dual-panel of local#278: modules/local-gpu must not advertise Free after hardware.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "modules/local-gpu/src/index.ts");

describe("local-gpu cost honesty (local#278)", () => {
  it("does not claim Free after hardware in the module manifest", () => {
    const raw = readFileSync(SRC, "utf8");
    expect(raw).not.toMatch(/Free after hardware/);
    expect(raw).toMatch(/model licence may apply|model license may apply/i);
    expect(raw).toMatch(/CogVideoX/);
  });
});
