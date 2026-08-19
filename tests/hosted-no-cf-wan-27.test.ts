import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

describe("hosted does not bind CF Wan 2.7", () => {
  it("wrangler.toml comments MODULE_CF_WAN_27 and binds MODULE_ALIBABA_WAN", () => {
    const toml = readFileSync(join(ROOT, "wrangler.toml.example"), "utf8");
    expect(toml).toMatch(/#\s*binding\s*=\s*"MODULE_CF_WAN_27"/);
    expect(toml).toMatch(/binding\s*=\s*"MODULE_ALIBABA_WAN"/);
    const live = toml.replace(/#[^\n]*/g, "\n");
    expect(live).not.toMatch(/binding\s*=\s*"MODULE_CF_WAN_27"/);
  });
});
