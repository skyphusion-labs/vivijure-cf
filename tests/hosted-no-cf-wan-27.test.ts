import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

describe("hosted does not ship CF Wan 2.7", () => {
  it("module directory is gone and wrangler does not bind it", () => {
    expect(existsSync(join(ROOT, "modules/cf-wan-27"))).toBe(false);
    const toml = readFileSync(join(ROOT, "wrangler.toml.example"), "utf8");
    expect(toml).toMatch(/binding\s*=\s*"MODULE_ALIBABA_WAN"/);
    expect(toml).not.toMatch(/MODULE_CF_WAN_27/);
    expect(toml).not.toMatch(/vivijure-module-cf-wan-27/);
  });
});
