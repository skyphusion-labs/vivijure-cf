// cf#1057: kling-o1-r2v is retired. The provider requires input.video, and the motion.backend hook has
// no video to send, so every render on this door failed after submit. Restoring the module means the
// hook gained a video input or the provider dropped the requirement. It does not mean re-enabling.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

describe("cf#1057 the kling-o1-r2v door is not offered", () => {
  it("has no module directory", () => {
    expect(existsSync(join(ROOT, "modules/kling-o1-r2v"))).toBe(false);
  });

  it("has no binding in the deploy template", () => {
    expect(readFileSync(join(ROOT, "wrangler.toml.example"), "utf8")).not.toMatch(/MODULE_KLING_O1_R2V|vivijure-module-kling-o1-r2v/);
  });

  it("the doors that replace it for silent motion are still on disk", () => {
    for (const door of ["minimax-hailuo", "cf-hailuo", "cf-hh1-r2v"]) {
      expect(existsSync(join(ROOT, "modules", door))).toBe(true);
    }
  });
});
