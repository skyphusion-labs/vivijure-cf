// cf#540: the planner's honest refusal at the finish-budget boundary.
//
// EVERY assertion here names the specific string it expects, never merely that a call produced
// SOMETHING or that a level was "error". A control that asserts only an outcome cannot notice
// when its subject moves underneath it; a control that demands a named string has to keep
// producing that string or go red for a reason a reader can act on.
//
// The mutation table proving each guard can go RED for its own named reason, with the siblings
// staying GREEN in the same run, is in the PR body.
import { describe, expect, it } from "vitest";
import checks, {
  type FinishModuleLike,
  type FinishSelection,
  type StoryboardLike,
} from "../public/finish-budget-checks.js";

function mod(over: Partial<FinishModuleLike> & { name: string }): FinishModuleLike {
  return { hooks: ["finish"], ...over } as FinishModuleLike;
}

const UPSCALE = mod({
  name: "finish-upscale",
  provides: [{ id: "upscale", label: "Upscale resolution (Real-ESRGAN)" }],
  participation: "default",
  finish_cost: {
    seconds_per_second: 268,
    budget_seconds: 1200,
    measured_on: "RTX 4000 SFF Ada",
    measured_at: "2026-08-14",
  },
});

const BLENDER = mod({
  name: "finish-blender",
  provides: [{ id: "grade", label: "Colour grade (Blender)" }],
  participation: "opt_in",
});

const RIFE_NO_COST = mod({
  name: "finish-rife",
  provides: [{ id: "interpolate", label: "Frame interpolation (RIFE)" }],
  participation: "default",
});

function sb(scenes: Array<{ id?: string; target_seconds?: number }>): StoryboardLike {
  return { scenes };
}

describe("cf#540 selection mirrors the core's selectForChain for the finish hook", () => {
  it("with NO selection, an opt_in module is excluded and a default module runs", () => {
    const picked = checks.selectedFinishModules([UPSCALE, BLENDER], undefined);
    expect(picked.map((m) => m.name)).toEqual(["finish-upscale"]);
  });

  it("NAMING an opt_in module opts it in -- naming overrides participation permissively", () => {
    const sel: FinishSelection = { mode: "named", modules: ["finish-blender"] };
    const picked = checks.selectedFinishModules([UPSCALE, BLENDER], sel);
    expect(picked.map((m) => m.name)).toEqual(["finish-blender"]);
  });

  it("NEGATIVE CONTROL: naming never widens past the named set", () => {
    const sel: FinishSelection = { mode: "named", modules: ["finish-blender"] };
    const picked = checks.selectedFinishModules([UPSCALE, BLENDER], sel);
    expect(picked.map((m) => m.name)).not.toContain("finish-upscale");
  });
});

describe("cf#540 a partial finish_cost declaration counts as NO declaration", () => {
  // A default here would invent a ceiling the module never promised, which is the failure this
  // whole issue is about arriving one layer down.
  it.each([
    ["missing budget", { seconds_per_second: 268 }],
    ["missing rate", { budget_seconds: 1200 }],
    ["zero rate", { seconds_per_second: 0, budget_seconds: 1200 }],
    ["negative budget", { seconds_per_second: 268, budget_seconds: -1 }],
    ["non-numeric rate", { seconds_per_second: "268", budget_seconds: 1200 }],
  ])("%s -> costOf returns null", (_name, cost) => {
    expect(checks.costOf(mod({ name: "x", finish_cost: cost as never }))).toBeNull();
  });

  it("POSITIVE CONTROL: a complete declaration DOES normalize, so the nulls above mean something", () => {
    const c = checks.costOf(UPSCALE);
    expect(c).not.toBeNull();
    expect(c!.rate).toBe(268);
    expect(c!.budget).toBe(1200);
    expect(c!.measuredOn).toBe("RTX 4000 SFF Ada");
    expect(c!.measuredAt).toBe("2026-08-14");
  });
});

describe("cf#540 the ceiling is DERIVED from the manifest and carries no constant of its own", () => {
  it("1200s budget at 268 s/s admits 4.4s", () => {
    const b = checks.finishBudget([UPSCALE], undefined, false);
    expect(b.state).toBe("derived");
    expect(b.maxSeconds).toBe(4.4);
  });

  it("the TIGHTEST door binds, because each door guards independently", () => {
    const cheap = mod({
      name: "finish-cheap",
      finish_cost: { seconds_per_second: 10, budget_seconds: 1200 },
    });
    const b = checks.finishBudget([UPSCALE, cheap], undefined, false);
    expect(b.state).toBe("derived");
    expect(b.maxSeconds).toBe(4.4);
    expect(b.binding!.module.name).toBe("finish-upscale");
  });

  it("an EMPTY chain is a derived answer of 'no finish work', not an absence", () => {
    const b = checks.finishBudget([], undefined, false);
    expect(b.state).toBe("derived");
    expect(b.maxSeconds).toBeNull();
    expect(checks.finishBudgetIssues(sb([{ id: "s1", target_seconds: 60 }]), b)).toEqual([]);
  });
});

describe("cf#540 the refusal names the number, the chain and the cause", () => {
  const budget = checks.finishBudget([UPSCALE], undefined, false);

  it("a 30s shot against a 4.4s ceiling is an ERROR that blocks the bundle", () => {
    const issues = checks.finishBudgetIssues(sb([{ id: "scene_03", target_seconds: 30 }]), budget);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("error");
    expect(issues[0].scope).toBe("scene[scene_03]");
  });

  it("the message names the PLANNED length, the CEILING, the CHAIN, the BUDGET and the RATE", () => {
    const m = checks.finishBudgetIssues(sb([{ id: "scene_03", target_seconds: 30 }]), budget)[0].message;
    expect(m).toContain("plans 30s");
    expect(m).toContain("at most 4.4s");
    expect(m).toContain("Upscale resolution (Real-ESRGAN)");
    expect(m).toContain("allows 1200s of finish work");
    expect(m).toContain("costs 268s per second of footage");
  });

  it("the message carries the measurement's PROVENANCE, so a dated number stays dated", () => {
    const m = checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 30 }]), budget)[0].message;
    expect(m).toContain("measured on RTX 4000 SFF Ada");
    expect(m).toContain("2026-08-14");
  });

  it("the message names a REMEDY, because a refusal that gives no way forward is a wall", () => {
    const m = checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 30 }]), budget)[0].message;
    expect(m).toContain("Shorten this shot to 4.4s or less");
    expect(m).toContain("deselect that finish module");
  });

  it("a module declaring no provenance produces NO provenance clause, never an invented one", () => {
    const bare = mod({ name: "finish-bare", finish_cost: { seconds_per_second: 268, budget_seconds: 1200 } });
    const m = checks.finishBudgetIssues(
      sb([{ id: "s", target_seconds: 30 }]),
      checks.finishBudget([bare], undefined, false),
    )[0].message;
    expect(m).not.toContain("measured");
  });

  it("NEGATIVE CONTROL: a shot AT the ceiling is admitted, and one just over is not", () => {
    expect(checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 4.4 }]), budget)).toEqual([]);
    expect(checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 4.5 }]), budget)).toHaveLength(1);
  });

  it("clip_seconds backfills a scene with no target_seconds, matching the planner's own backfill", () => {
    const issues = checks.finishBudgetIssues({ scenes: [{ id: "s" }], clip_seconds: 30 }, budget);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("plans 30s");
  });
});

describe("cf#540 UNKNOWN admits, and is never silent", () => {
  it("one undeclared module makes the WHOLE chain underivable, not partially derived", () => {
    const b = checks.finishBudget([UPSCALE, RIFE_NO_COST], undefined, false);
    expect(b.state).toBe("undeclared");
    expect(b.maxSeconds).toBeNull();
    expect(b.undeclared.map((m) => m.name)).toEqual(["finish-rife"]);
  });

  it("an underivable ceiling ADMITS a 60s shot rather than refusing correct work", () => {
    const b = checks.finishBudget([RIFE_NO_COST], undefined, false);
    const issues = checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 60 }]), b);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("but it says so ONCE, naming which module declared nothing", () => {
    const b = checks.finishBudget([UPSCALE, RIFE_NO_COST], undefined, false);
    const issues = checks.finishBudgetIssues(
      sb([{ id: "a", target_seconds: 60 }, { id: "b", target_seconds: 60 }]),
      b,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("info");
    expect(issues[0].message).toContain("cannot be derived");
    expect(issues[0].message).toContain("Frame interpolation (RIFE)");
    expect(issues[0].message).toContain("may still fail at the finish door");
  });

  it("NEGATIVE CONTROL: the underivable notice is NOT reassuring -- it never says the shot is fine", () => {
    const b = checks.finishBudget([RIFE_NO_COST], undefined, false);
    const m = checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 60 }]), b)[0].message;
    expect(m).not.toMatch(/\bwill finish\b|\bis fine\b|\bno problem\b|\bsafe\b/i);
  });
});

describe("cf#540 'could not ask' is a DIFFERENT fact from 'nothing to say'", () => {
  it("a failed registry load reports UNAVAILABLE, never an empty derived chain", () => {
    const b = checks.finishBudget([], undefined, true);
    expect(b.state).toBe("unavailable");
  });

  it("its message refuses to be read as a claim about the studio", () => {
    const b = checks.finishBudget([], undefined, true);
    const m = checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 60 }]), b)[0].message;
    expect(m).toContain("registry did not load");
    expect(m).toContain("not a statement about what this studio has installed");
  });

  it("DISCRIMINATION: an unavailable registry and an empty installed chain differ, with IDENTICAL inputs otherwise", () => {
    const unavailable = checks.finishBudget([], undefined, true);
    const emptyInstalled = checks.finishBudget([], undefined, false);
    expect(unavailable.state).not.toBe(emptyInstalled.state);
    expect(checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 60 }]), unavailable)).toHaveLength(1);
    expect(checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 60 }]), emptyInstalled)).toHaveLength(0);
  });

  it("an unavailable registry still ADMITS, because we could not ask is not a reason to refuse", () => {
    const b = checks.finishBudget([], undefined, true);
    const issues = checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 60 }]), b);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("cf#540 the file introduces NO constant of its own", () => {
  // The whole thesis of the issue is that a fourth independent number reopens this silently.
  // This asserts the property structurally rather than trusting a reviewer to notice a literal.
  it("changing ONLY the manifest changes the ceiling, so no number is baked in", () => {
    const a = checks.finishBudget(
      [mod({ name: "m", finish_cost: { seconds_per_second: 268, budget_seconds: 1200 } })],
      undefined,
      false,
    );
    const b = checks.finishBudget(
      [mod({ name: "m", finish_cost: { seconds_per_second: 113.9, budget_seconds: 1200 } })],
      undefined,
      false,
    );
    expect(a.maxSeconds).toBe(4.4);
    expect(b.maxSeconds).toBe(10.5);
    expect(a.maxSeconds).not.toBe(b.maxSeconds);
  });
});

// ---------------------------------------------------------------------------
// cf#540 second pass: the COUNTABLE denominator.
//
// The first pass shipped "unknown admits, and says so once per render". That was endorsed with a
// requirement attached, and the requirement is a correction to our own reasoning: one info line
// per render is a LOG ENTRY, and a log entry is what nobody reads. Six months on, every module
// still declares nothing, the guard has never refused once, and it reads on the board as shipped
// and working -- a gate that passes because it matched nothing, rebuilt inside the decision we
// argued for.
//
// The sharper half: we separated `unavailable` from `undeclared` per render BECAUSE they are
// different facts owned by different parties, and then failed to apply that same distinction one
// level up. An aggregate that renders "could not read the registry" as a low N is exactly the
// collapse we refused per-module.
// ---------------------------------------------------------------------------

describe("cf#540 the coverage denominator is DERIVED, never hardcoded", () => {
  it("counts modules that declare a finish cost against the finish modules INSTALLED", () => {
    const c = checks.finishCostCoverage([UPSCALE, RIFE_NO_COST, BLENDER], false);
    expect(c.state).toBe("measured");
    expect(c.declared).toBe(1);
    expect(c.installed).toBe(3);
  });

  it("the denominator MOVES with the registry, so it cannot drift from what is installed", () => {
    const two = checks.finishCostCoverage([UPSCALE, RIFE_NO_COST], false);
    const three = checks.finishCostCoverage([UPSCALE, RIFE_NO_COST, BLENDER], false);
    expect(two.installed).toBe(2);
    expect(three.installed).toBe(3);
    expect(two.installed).not.toBe(three.installed);
  });

  it("counts an OPT-IN module too, because it is installed whether or not this render selects it", () => {
    // The coverage number is a property of the STUDIO, not of one render. An opt_in module that
    // declares nothing is still a hole in the estate's coverage, and excluding it would let the
    // number read complete while a selectable module remains silent.
    const c = checks.finishCostCoverage([UPSCALE, BLENDER], false);
    expect(c.installed).toBe(2);
    expect(c.undeclared.map((m) => m.name)).toContain("finish-blender");
  });

  it("names WHICH modules are silent, so the number is actionable and not just a score", () => {
    const c = checks.finishCostCoverage([UPSCALE, RIFE_NO_COST], false);
    expect(c.undeclared.map((m) => m.name)).toEqual(["finish-rife"]);
  });

  it("zero installed finish modules is a real MEASURED zero, not an absence", () => {
    const c = checks.finishCostCoverage([], false);
    expect(c.state).toBe("measured");
    expect(c.declared).toBe(0);
    expect(c.installed).toBe(0);
  });

  it("a partial declaration does not count as declared, matching costOf", () => {
    const partial = mod({ name: "finish-partial", finish_cost: { seconds_per_second: 268 } as never });
    const c = checks.finishCostCoverage([partial], false);
    expect(c.declared).toBe(0);
    expect(c.installed).toBe(1);
  });
});

describe("cf#540 THE AGGREGATE CARRIES THE SAME THREE-WAY SPLIT AS THE PER-RENDER PATH", () => {
  // This block is the whole point of the second pass. If these can be satisfied by an
  // implementation that reports a number when it could not read the registry, nothing has changed.

  it("an unreadable registry reports UNAVAILABLE, never a count", () => {
    const c = checks.finishCostCoverage([], true);
    expect(c.state).toBe("unavailable");
  });

  it("STRUCTURAL: an unreadable registry reports NULL, never 0 of 0", () => {
    const c = checks.finishCostCoverage([], true);
    expect(c.declared).toBeNull();
    expect(c.installed).toBeNull();
    expect(c.declared).not.toBe(0);
    expect(c.installed).not.toBe(0);
  });

  it("STRUCTURAL: an unreadable registry reports NULL even when modules were passed, never 0 of M", () => {
    // The dangerous shape: a stale or partial module list survives a failed refetch and gets
    // counted, so "could not ask" renders as a low score against a real-looking denominator.
    const c = checks.finishCostCoverage([UPSCALE, RIFE_NO_COST, BLENDER], true);
    expect(c.state).toBe("unavailable");
    expect(c.declared).toBeNull();
    expect(c.installed).toBeNull();
  });

  it("DISCRIMINATION: cannot-ask and nothing-installed differ, with IDENTICAL module inputs", () => {
    const cannotAsk = checks.finishCostCoverage([], true);
    const noneInstalled = checks.finishCostCoverage([], false);
    expect(cannotAsk.state).not.toBe(noneInstalled.state);
    expect(cannotAsk.installed).toBeNull();
    expect(noneInstalled.installed).toBe(0);
  });

  it("DISCRIMINATION: cannot-ask and none-declared differ, with IDENTICAL module inputs", () => {
    const cannotAsk = checks.finishCostCoverage([RIFE_NO_COST], true);
    const noneDeclared = checks.finishCostCoverage([RIFE_NO_COST], false);
    expect(cannotAsk.state).not.toBe(noneDeclared.state);
    expect(cannotAsk.declared).toBeNull();
    expect(noneDeclared.declared).toBe(0);
  });
});

describe("cf#540 the coverage line is STRUCTURED, and readable without grepping renders", () => {
  it("renders a machine-readable triple a check can assert on", () => {
    const a = checks.coverageAttrs(checks.finishCostCoverage([UPSCALE, RIFE_NO_COST], false));
    expect(a["data-finish-cost-state"]).toBe("measured");
    expect(a["data-finish-cost-declared"]).toBe("1");
    expect(a["data-finish-cost-installed"]).toBe("2");
  });

  it("the machine-readable triple carries NO number when the registry could not be read", () => {
    const a = checks.coverageAttrs(checks.finishCostCoverage([UPSCALE], true));
    expect(a["data-finish-cost-state"]).toBe("unavailable");
    expect(a["data-finish-cost-declared"]).toBe("");
    expect(a["data-finish-cost-installed"]).toBe("");
  });

  it("the human line states N of M in terms", () => {
    const t = checks.coverageText(checks.finishCostCoverage([UPSCALE, RIFE_NO_COST], false));
    expect(t).toContain("declared by 1 of 2 installed finish modules");
  });

  it("the human line for a total hole reads as an argument with a denominator attached", () => {
    const t = checks.coverageText(checks.finishCostCoverage([RIFE_NO_COST, BLENDER], false));
    expect(t).toContain("declared by 0 of 2 installed finish modules");
  });

  it("the human line for an unreadable registry states the FAILURE, never a score", () => {
    const t = checks.coverageText(checks.finishCostCoverage([UPSCALE], true));
    expect(t).toContain("could not be read");
    expect(t).not.toMatch(/\d+ of \d+/);
  });

  it("NEGATIVE CONTROL: no coverage line ever claims the shots are safe", () => {
    const lines = [
      checks.coverageText(checks.finishCostCoverage([UPSCALE], false)),
      checks.coverageText(checks.finishCostCoverage([RIFE_NO_COST], false)),
      checks.coverageText(checks.finishCostCoverage([UPSCALE], true)),
    ];
    for (const t of lines) {
      expect(t).not.toMatch(/\bwill finish\b|\bis fine\b|\bno problem\b|\bsafe\b/i);
    }
  });
});

describe("cf#540 the per-render info line carries the COUNT, so the render path is countable too", () => {
  it("the undeclared notice states N of M rather than only naming modules", () => {
    const b = checks.finishBudget([UPSCALE, RIFE_NO_COST], undefined, false);
    const m = checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 60 }]), b, [UPSCALE, RIFE_NO_COST])[0].message;
    expect(m).toContain("1 of 2 installed finish modules");
  });

  it("the guard the lead asked to survive: that notice still never reassures", () => {
    const b = checks.finishBudget([RIFE_NO_COST], undefined, false);
    const m = checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 60 }]), b, [RIFE_NO_COST])[0].message;
    expect(m).not.toMatch(/\bwill finish\b|\bis fine\b|\bno problem\b|\bsafe\b/i);
    expect(m).toContain("may still fail at the finish door");
  });

  it("omitting the module list keeps the notice honest rather than printing a wrong denominator", () => {
    const b = checks.finishBudget([RIFE_NO_COST], undefined, false);
    const m = checks.finishBudgetIssues(sb([{ id: "s", target_seconds: 60 }]), b)[0].message;
    expect(m).not.toMatch(/\d+ of \d+ installed/);
  });
});
