// cf#931: infinitetalk's 15 second ceiling is our own cap, and it is held in ONE place and said out loud.
//
// RunPod's InfiniteTalk endpoint has no duration parameter and publishes no length limit, so the number
// cannot be cited to the vendor. These cases keep the three places that state it (the manifest the core
// plans from, the clamp the module applies, and the published door-limits doc) from drifting apart, and
// keep the doc from presenting it as the vendor's limit.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../modules/infinitetalk/src/index";
import { MAX_SECONDS, MIN_SECONDS, clampDuration } from "../modules/infinitetalk/src/kling";

const ROOT = join(import.meta.dirname, "..");

async function usage(): Promise<Record<string, unknown>> {
  const res = await (worker as unknown as { fetch(r: Request, e: never): Promise<Response> }).fetch(
    new Request("https://module.internal/module.json"),
    {} as never,
  );
  return ((await res.json()) as { usage: Record<string, unknown> }).usage;
}

describe("cf#931: one cap, declared and applied the same", () => {
  it("the served manifest declares exactly the module's bounds", async () => {
    const u = await usage();
    expect(u.min_seconds).toBe(MIN_SECONDS);
    expect(u.max_seconds).toBe(MAX_SECONDS);
  });

  it("the clamp applies the same bounds", () => {
    expect(clampDuration(MAX_SECONDS + 40)).toBe(MAX_SECONDS);
    expect(clampDuration(0.4)).toBe(MIN_SECONDS);
    expect(clampDuration(MAX_SECONDS - 1)).toBe(MAX_SECONDS - 1);
  });

  it("the value is still 15 until a measurement says otherwise", () => {
    // Changing this means a probe ran. Cite it beside MAX_SECONDS in modules/infinitetalk/src/kling.ts.
    expect(MAX_SECONDS).toBe(15);
  });
});

describe("cf#931: the door-limits doc says whose cap it is", () => {
  const doc = readFileSync(join(ROOT, "docs/motion-door-limits.md"), "utf8");
  const section = doc.split("## infinitetalk")[1]?.split("\n## ")[0] ?? "";

  it("CONTROL: the section was found", () => {
    expect(section).toMatch(/Portrait plus Cast audio/);
  });

  it("names the range, calls it OUR cap, and points at the probe", () => {
    expect(section).toContain(`${MIN_SECONDS}-${MAX_SECONDS} seconds`);
    expect(section).toMatch(/OUR cap, not RunPod's/);
    expect(section).toMatch(/no duration parameter/);
    expect(section).toContain("cf#931");
  });
});
