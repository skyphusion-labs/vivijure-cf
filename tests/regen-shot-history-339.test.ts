import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

// cf#339: hRegenShot was the only startFilmJob door that wrote no renders row.

describe("hRegenShot history row (cf#339)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts"), "utf8");
  const start = src.indexOf("const hRegenShot");
  const end = src.indexOf("const hPollRender", start);
  const body = start >= 0 && end > start ? src.slice(start, end) : "";

  it("is present as a distinct handler", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("writes a renders row via insertRenderBestEffort (siblings all do)", () => {
    expect(body).toContain("insertRenderBestEffort");
  });

  it("records keyframes-only mode and parent_id of the COMPLETED source render", () => {
    expect(body).toContain('mode: "keyframes-only"');
    expect(body).toContain("parentId: row.id");
  });
});
