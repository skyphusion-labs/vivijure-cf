// vivijure-cf#879 (MA-8): finish-rife declares its frame-rate change (finish_artifacts.rate_factor), so the
// core can stop reading it off the binding name. The declaration must give the SAME factor the legacy
// /RIFE/ reading gives today, for every config the schema allows, or dropping the fallback changes what
// a film ships at. The legacy reading is core's own finishStepRateFactor (2-argument form, which on the
// pinned core is the binding rule). The declared reading follows the core contract text (core#536).
import { describe, expect, it } from "vitest";
import { MANIFEST } from "../modules/finish-rife/src/manifest";
import { finishStepRateFactor } from "@skyphusion-labs/vivijure-core/film-model";

type RateFactor = { knob: string; default: number; off_when?: { knob: string; equals: unknown } };
function declaredFactor(rf: RateFactor, config: Record<string, unknown>): number {
  if (rf.off_when && config[rf.off_when.knob] === rf.off_when.equals) return 1;
  const v = Number(config[rf.knob] ?? rf.default);
  return Number.isFinite(v) && v > 1 ? v : 1;
}

describe("finish-rife rate_factor", () => {
  const rf = MANIFEST.finish_artifacts?.rate_factor as RateFactor | undefined;

  it("is declared, on the knobs the schema has", () => {
    expect(rf).toEqual({ knob: "interpolation_factor", default: 2, off_when: { knob: "interpolate", equals: false } });
    expect(MANIFEST.config_schema?.interpolation_factor).toBeDefined();
    expect(MANIFEST.config_schema?.interpolate).toBeDefined();
    expect(rf!.default).toBe((MANIFEST.config_schema?.interpolation_factor as { default: number }).default);
  });

  const configs: Record<string, unknown>[] = [{}];
  for (const interpolate of [undefined, true, false]) {
    for (const interpolation_factor of [undefined, 1, 2, 4, 8]) {
      const c: Record<string, unknown> = {};
      if (interpolate !== undefined) c.interpolate = interpolate;
      if (interpolation_factor !== undefined) c.interpolation_factor = interpolation_factor;
      configs.push(c);
    }
  }
  it(`gives the legacy factor for all ${configs.length} schema configs`, () => {
    for (const c of configs) {
      expect(declaredFactor(rf!, c), JSON.stringify(c)).toBe(finishStepRateFactor("MODULE_FINISH_RIFE", c));
    }
  });
  it("CONTROL: the comparison can fail (a wrong default would be caught)", () => {
    expect(declaredFactor({ ...rf!, default: 3 }, {})).not.toBe(finishStepRateFactor("MODULE_FINISH_RIFE", {}));
  });
});
