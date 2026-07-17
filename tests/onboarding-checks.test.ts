import { describe, expect, it } from "vitest";

import {
  KEY_PREFIX,
  STEPS,
  canAdvance,
  costCeilingUsd,
  formatUsd,
  keyShapeHint,
  planWorkerTotal,
  quotaFit,
  stepIndex,
  type PlannedEndpoint,
} from "../hosted/public/onboarding-checks.js";

// The hosted onboarding front door (#58). These helpers carry the claims the
// flow makes to a stranger about their money and their RunPod account, so the
// gates get negative tests: a guard that has never been watched to FAIL is not
// a guard.

const PLAN: PlannedEndpoint[] = [
  { key: "backend", label: "backend", purpose: "render", image: "ghcr.io/x/backend", max_workers: 2 },
  { key: "upscale", label: "upscale", purpose: "sharper", image: "ghcr.io/x/upscale", max_workers: 1 },
  { key: "lipsync", label: "lipsync", purpose: "mouths", image: "ghcr.io/x/musetalk", max_workers: 1 },
  { key: "audio-upscale", label: "audio-upscale", purpose: "audio", image: "ghcr.io/x/audio", max_workers: 1 },
];

describe("keyShapeHint", () => {
  it("says nothing on an empty field", () => {
    expect(keyShapeHint("").level).toBe("empty");
    expect(keyShapeHint(null).level).toBe("empty");
    expect(keyShapeHint(undefined).message).toBe("");
  });

  it("accepts a current-format key", () => {
    const hint = keyShapeHint(KEY_PREFIX + "0123456789abcdef");
    expect(hint.level).toBe("ok");
  });

  it("warns on a legacy key (pre-2024-11 keys have different permission semantics)", () => {
    const hint = keyShapeHint("ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    expect(hint.level).toBe("warn");
    expect(hint.message).toContain(KEY_PREFIX);
  });

  it("warns on a truncated key rather than letting a bad paste reach RunPod", () => {
    expect(keyShapeHint(KEY_PREFIX + "abc").level).toBe("warn");
  });

  it("trims surrounding whitespace from a paste", () => {
    expect(keyShapeHint("  " + KEY_PREFIX + "0123456789abcdef  ").level).toBe("ok");
  });

  it("never echoes the key back in the hint (secret hygiene)", () => {
    const secret = KEY_PREFIX + "supersecretvalue1234";
    expect(keyShapeHint(secret).message).not.toContain("supersecretvalue");
  });
});

describe("planWorkerTotal", () => {
  it("sums the pinned max_workers across the plan", () => {
    expect(planWorkerTotal(PLAN)).toBe(5);
  });

  it("is zero for a missing or empty plan", () => {
    expect(planWorkerTotal([])).toBe(0);
    expect(planWorkerTotal(null)).toBe(0);
  });

  it("ignores rows with a nonsense worker count instead of producing NaN", () => {
    const junk = [
      { key: "a", label: "a", purpose: "", image: "", max_workers: Number.NaN },
      { key: "b", label: "b", purpose: "", image: "", max_workers: -3 },
      { key: "c", label: "c", purpose: "", image: "", max_workers: 2 },
    ] as PlannedEndpoint[];
    expect(planWorkerTotal(junk)).toBe(2);
  });
});

describe("quotaFit", () => {
  it("fits the plan on an account with room", () => {
    const fit = quotaFit(10, 0, PLAN);
    expect(fit.fits).toBe(true);
    expect(fit.needed).toBe(5);
    // available is the room on the ACCOUNT (quota minus what existing
    // endpoints already spend), not the size of this plan.
    expect(fit.available).toBe(10);
    expect(fit.guidance).toEqual([]);
  });

  it("counts the account-wide sum, not just this plan (#60: quota is enforced across ALL endpoints)", () => {
    const fit = quotaFit(10, 7, PLAN);
    expect(fit.fits).toBe(false);
    expect(fit.available).toBe(3);
    expect(fit.needed).toBe(5);
  });

  it("REFUSES rather than half-building when the account has no room", () => {
    const fit = quotaFit(5, 4, PLAN);
    expect(fit.fits).toBe(false);
    expect(fit.message).toContain("Setup stops here");
    expect(fit.guidance.length).toBeGreaterThan(0);
    expect(fit.guidance[0]).toContain("4");
  });

  it("fits exactly at the boundary", () => {
    expect(quotaFit(5, 0, PLAN).fits).toBe(true);
    expect(quotaFit(5, 1, PLAN).fits).toBe(false);
  });

  it("REFUSES when the real quota could not be read, instead of guessing from the balance table", () => {
    for (const bad of [null, undefined, 0, Number.NaN, "unknown"]) {
      const fit = quotaFit(bad as number, 0, PLAN);
      expect(fit.fits).toBe(false);
      expect(fit.known).toBe(false);
      expect(fit.message).toContain("will not guess");
    }
  });

  it("surfaces the REAL number it was given, never a funding tier", () => {
    // Conrad's own account: $50 funded, quota 10 from day one. The docs table
    // says that account should have 5. We report what RunPod actually told us.
    const fit = quotaFit(10, 0, PLAN);
    expect(fit.quota).toBe(10);
    expect(fit.message).toContain("10");
    expect(fit.message).not.toMatch(/\$\d/);
  });
});

describe("costCeilingUsd / formatUsd", () => {
  it("computes the ceiling from wall-clock and the hourly rate", () => {
    // film-2294a9d7 (2026-07-14): 2 shots, 10s of finished video, 362857ms
    // wall-clock, H200 secure at $4.39/hr as listed 2026-07-17.
    const ceiling = costCeilingUsd(362857, 4.39);
    expect(ceiling).toBeCloseTo(0.4425, 3);
    expect(formatUsd(ceiling)).toBe("$0.44");
  });

  it("returns null on junk rather than a fabricated number", () => {
    expect(costCeilingUsd(0, 4.39)).toBeNull();
    expect(costCeilingUsd(-5, 4.39)).toBeNull();
    expect(costCeilingUsd(1000, 0)).toBeNull();
    expect(costCeilingUsd(null, 4.39)).toBeNull();
    expect(costCeilingUsd(1000, null)).toBeNull();
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd(Number.NaN)).toBeNull();
  });

  it("never rounds a real cost down to a free-looking $0.00", () => {
    expect(formatUsd(0.004)).toBe("under $0.01");
    expect(formatUsd(0.001)).not.toBe("$0.00");
  });
});

describe("canAdvance (the gates)", () => {
  it("blocks the rules step until the AUP is accepted", () => {
    expect(canAdvance("rules", { rulesAccepted: false })).toBe(false);
    expect(canAdvance("rules", {})).toBe(false);
    expect(canAdvance("rules", null)).toBe(false);
    expect(canAdvance("rules", { rulesAccepted: true })).toBe(true);
  });

  it("blocks the key step until a key is present", () => {
    expect(canAdvance("key", { keyPresent: false })).toBe(false);
    expect(canAdvance("key", {})).toBe(false);
    expect(canAdvance("key", { keyPresent: true })).toBe(true);
  });

  it("blocks the capacity step on a failed OR missing capacity check", () => {
    expect(canAdvance("capacity", { capacity: null })).toBe(false);
    expect(canAdvance("capacity", {})).toBe(false);
    expect(canAdvance("capacity", { capacity: quotaFit(5, 4, PLAN) })).toBe(false);
    expect(canAdvance("capacity", { capacity: quotaFit(10, 0, PLAN) })).toBe(true);
  });

  it("blocks the review step until create is explicitly confirmed", () => {
    expect(canAdvance("review", { confirmed: false })).toBe(false);
    expect(canAdvance("review", {})).toBe(false);
    expect(canAdvance("review", { confirmed: true })).toBe(true);
  });

  it("does not gate the informational steps", () => {
    expect(canAdvance("what", {})).toBe(true);
    expect(canAdvance("build", {})).toBe(true);
  });
});

describe("STEPS / stepIndex", () => {
  it("orders the flow: understand and consent BEFORE the key is asked for", () => {
    expect(STEPS.map((s) => s.key)).toEqual([
      "what", "rules", "key", "capacity", "review", "build", "done",
    ]);
    expect(stepIndex("what")).toBeLessThan(stepIndex("key"));
    expect(stepIndex("rules")).toBeLessThan(stepIndex("key"));
    // Nothing is created on the tenant's account before an explicit review.
    expect(stepIndex("review")).toBeLessThan(stepIndex("build"));
  });

  it("returns -1 for an unknown step", () => {
    expect(stepIndex("nope")).toBe(-1);
  });
});
