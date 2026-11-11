// cf#1075: seedance, google-veo, and vidu-q3 are retired. Restoring a directory or a
// deploy binding is a new door, not a re-enable. cf-vidu-q3-turbo is the Vidu replacement.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

describe("cf#1075 retired RunPod doors are not offered", () => {
  it("has no module directory", () => {
    for (const door of ["seedance", "google-veo", "vidu-q3"]) {
      expect(existsSync(join(ROOT, "modules", door)), door).toBe(false);
    }
  });

  it("has no binding in the deploy template", () => {
    const toml = readFileSync(join(ROOT, "wrangler.toml.example"), "utf8");
    expect(toml).not.toMatch(/MODULE_SEEDANCE|vivijure-module-seedance/);
    expect(toml).not.toMatch(/MODULE_GOOGLE_VEO|vivijure-module-google-veo/);
    expect(toml).not.toMatch(/MODULE_VIDU_Q3|vivijure-module-vidu-q3/);
  });

  it("keeps the doors that still serve those jobs", () => {
    for (const door of ["cf-veo", "cf-seedance", "cf-vidu-q3-turbo", "minimax-hailuo"]) {
      expect(existsSync(join(ROOT, "modules", door)), door).toBe(true);
    }
    const toml = readFileSync(join(ROOT, "wrangler.toml.example"), "utf8");
    expect(toml).toMatch(/MODULE_CF_VIDU_Q3_TURBO/);
    expect(toml).toMatch(/vivijure-module-cf-vidu-q3-turbo/);
  });
});
