import { describe, expect, it } from "vitest";
import { MANIFEST as KEYFRAME } from "../modules/keyframe/src/manifest";
import { MANIFEST as OWN_GPU } from "../modules/own-gpu/src/manifest";

// vivijure-backend#563: the GPU backend has no random seed. The keyframe and own-gpu modules do not send
// -1 (they send only a seed >= 0), so -1 means the backend's own default seed, which is fixed: the same
// picture or motion on every run. The manifest label is what the panel shows next to the control (it is
// projected from config_schema), so it must not promise "random". Read at vivijure-backend 834f3b2:
// KeyframeConfig.seed default 424242 and I2VConfig.seed default 0, and a -1 that is sent clamps to 0.

const seedLabel = (m: { config_schema: Record<string, { label?: string; default?: unknown }> }) => m.config_schema.seed;

describe("the seed label says what -1 does on our backend", () => {
  for (const [name, m] of [["keyframe", KEYFRAME], ["own-gpu", OWN_GPU]] as const) {
    it(`${name}: -1 is the backend default, never "random"`, () => {
      const s = seedLabel(m as never);
      expect(s.default).toBe(-1);
      expect(s.label).not.toMatch(/random/i);
      expect(s.label).toContain("-1 = backend default");
    });
  }
});
