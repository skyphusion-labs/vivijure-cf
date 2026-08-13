/// <reference types="node" />
// EXPLICIT WINS. A target-derived upscale factor must never override a scale the user actually set.
//
// THIS IS core#174, ONE FIELD OVER. That bug had `resolveCastTrainFamily` treat an explicit
// `model_family: "wan"` as byte-identical to sending nothing, so a user was billed for a job they
// did not choose; its fix records the rule in terms -- "We do NOT substitute a different model
// family for a request the user actually made." `scale` has a UI control, so a user setting it is a
// request actually made, and overriding it is the same defect with a different noun.
//
// AND THE FAILURE WOULD BE SILENT. A user who set 4 and got 2 sees a correct-looking film and no
// message: no error, no degrade tag, nothing to notice. That is why the distinction has to be
// carried rather than inferred.
//
// SO THIS IS THE THIRD INSTANCE OF ONE RULE -- an absence must never render as a value. Here the
// absence is "the user expressed no preference", and `coerceConfig` could not express it:
//
//     const scale = Number(cfg.scale ?? base.scale);   // explicit 2 and absent are IDENTICAL
//
// NON-DEFAULT PROBES. The module default is 2, so a test that asserts 2 proves nothing about
// whether a 2 was chosen or fell out. Every explicit case below uses 4, and the derived cases use
// targets that force a factor different from what the user would have got by default.

import { describe, it, expect } from "vitest";
import { coerceConfig, defaultConfig, resolveUpscaleScale } from "../modules/finish-upscale/src/finish";

const TARGET = { width: 1280, height: 536 };   // deliberately not 1920x1080

describe("coerceConfig: an explicit scale is distinguishable from a defaulted one", () => {
  it("reports scaleExplicit=false when the caller expressed no preference", () => {
    const c = coerceConfig({});
    expect(c.scale).toBe(defaultConfig().scale);
    expect(c.scaleExplicit).toBe(false);
  });

  it("reports scaleExplicit=true for an explicit value that EQUALS the default", () => {
    // The load-bearing case and the one the old code could not express: an explicit 2 and an absent
    // 2 produced identical output, so a user who deliberately chose 2 was indistinguishable from a
    // user who chose nothing -- and derivation would have silently overridden the first.
    const c = coerceConfig({ scale: 2 });
    expect(c.scale).toBe(2);
    expect(c.scaleExplicit).toBe(true);
  });

  it("reports scaleExplicit=true for an explicit 4", () => {
    const c = coerceConfig({ scale: 4 });
    expect(c.scale).toBe(4);
    expect(c.scaleExplicit).toBe(true);
  });

  it("a value that is not a usable number is NOT a preference", () => {
    // Garbage is not a choice. Treating it as explicit would pin the user to a factor they never
    // expressed and suppress derivation on the strength of a typo.
    for (const junk of [{ scale: null }, { scale: "abc" }, { scale: Number.NaN }, { scale: undefined }]) {
      expect(coerceConfig(junk as Record<string, unknown>).scaleExplicit).toBe(false);
    }
  });
});

describe("resolveUpscaleScale: derivation fills a hole, it does not win an argument", () => {
  it("an EXPLICIT scale is honoured even when derivation would pick another", () => {
    // Source 400x200 against a 1280x536 target needs 4x to clear. The user asked for 2.
    const r = resolveUpscaleScale(coerceConfig({ scale: 2 }), { width: 400, height: 200 }, TARGET);
    expect(r.scale).toBe(2);
    expect(r.derived).toBe(false);          // it came from the user, not from the target
  });

  it("an explicit scale that CANNOT reach the target is honoured AND the shortfall is recorded", () => {
    // The honest middle. Not silently overridden ("we ignored you") and not silently under-delivered
    // ("we did what you asked and said nothing about what it means").
    const r = resolveUpscaleScale(coerceConfig({ scale: 2 }), { width: 400, height: 200 }, TARGET);
    expect(r.scale).toBe(2);
    expect(r.undershoots).toBe(true);
  });

  it("an explicit scale that DOES reach the target reports no shortfall", () => {
    // CONTROL for the case above: without this, `undershoots: true` could be a constant.
    const r = resolveUpscaleScale(coerceConfig({ scale: 4 }), { width: 400, height: 200 }, TARGET);
    expect(r.scale).toBe(4);
    expect(r.undershoots).toBe(false);
  });

  it("with NO explicit scale, the factor is DERIVED from the target", () => {
    const r = resolveUpscaleScale(coerceConfig({}), { width: 400, height: 200 }, TARGET);
    expect(r.scale).toBe(4);                // 2x would land at 800x400, under on both axes
    expect(r.derived).toBe(true);
  });

  it("with no explicit scale and no measurable source, it falls back to the module default", () => {
    // Unknown source dims are the lookup-miss case. No target to compare against means no
    // derivation is possible, and inventing one would be the guess this whole change removes.
    const r = resolveUpscaleScale(coerceConfig({}), { width: 0, height: 0 }, TARGET);
    expect(r.scale).toBe(defaultConfig().scale);
    expect(r.derived).toBe(false);
  });

  it("with no explicit scale and no TARGET, it falls back too", () => {
    const r = resolveUpscaleScale(coerceConfig({}), { width: 864, height: 496 }, { width: 0, height: 0 });
    expect(r.derived).toBe(false);
  });

  it("DISCRIMINATION: explicit-2 and derived-2 are the same factor and DIFFERENT records", () => {
    // If these two collapsed, nothing downstream could tell a user's choice from our inference --
    // which is precisely the state coerceConfig was in before this change.
    const explicit = resolveUpscaleScale(coerceConfig({ scale: 2 }), { width: 864, height: 496 }, TARGET);
    const derivedR = resolveUpscaleScale(coerceConfig({}), { width: 864, height: 496 }, TARGET);
    expect(explicit.scale).toBe(derivedR.scale);      // same number
    expect(explicit.derived).not.toBe(derivedR.derived); // different provenance
  });
});
