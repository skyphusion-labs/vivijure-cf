import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The expert JSON box shows an example a filmmaker can copy. A door named there has to exist.

const html = readFileSync(join(__dirname, "..", "public", "planner.html"), "utf8");

describe("the planner render_overrides examples", () => {
  const names = [...html.matchAll(/"motion_backend":\s*"([^"]+)"/g)].map((m) => m[1]);

  it("finds both examples (control)", () => {
    expect(names.length).toBe(2);
  });

  it("names a door that is on disk", () => {
    for (const name of names) expect(existsSync(join(__dirname, "..", "modules", name)), name).toBe(true);
  });
});
