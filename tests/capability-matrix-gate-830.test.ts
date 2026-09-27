// vivijure#830: the capability-matrix gate had ZERO tests, while blocking two lanes.
//
// It exported parseMatrixModules "so a test can import it" and no test ever did. The gate could only
// be exercised by pointing it at the live hub and hoping the state of two repos happened to express
// the case you wanted, which means the transition widening added here could not be shown to still
// catch anything. So evaluateMatrix is now pure and every case below drives it to a verdict.
//
// THE CONTROLS ARE THE POINT. A widening is only safe if the un-widened cases still fail, so each
// tolerance test has a paired assertion that the SAME shape without the declaration is caught.
import { describe, expect, it } from "vitest";
import {
  evaluateMatrix,
  type MatrixTransition,
  parseMatrixModules,
  parseRetiredNames,
  parseTransitions,
} from "../scripts/check-capability-matrix.mjs";

function run(o: {
  actual: string[];
  declared: string[];
  transitions?: MatrixTransition[];
  retired?: string[];
  hooks?: Record<string, number>;
}) {
  const appearances = new Map<string, number>();
  for (const n of o.declared) appearances.set(n, (appearances.get(n) || 0) + 1);
  return evaluateMatrix({
    actual: o.actual,
    declared: new Set(o.declared),
    appearances,
    transitions: o.transitions ?? [],
    retired: o.retired ?? [],
    hookCount: (n: string) => o.hooks?.[n] ?? 1,
  });
}

describe("vivijure#830 the gate still catches what it always caught", () => {
  it("agreement is clean", () => {
    expect(run({ actual: ["a", "b"], declared: ["a", "b"] }).problems).toEqual([]);
  });

  it("CONTROL: a module with no matrix row FAILS when nothing declares a transition", () => {
    const { problems } = run({ actual: ["a", "orphan"], declared: ["a"] });
    expect(problems.join(" ")).toMatch(/orphan/);
    expect(problems.join(" ")).toMatch(/silently missing a capability/);
  });

  it("CONTROL: a matrix row naming a module that does not exist FAILS, and is NOT excused by the Retired section alone", () => {
    // The sharp case the ruling asked for: absent AND not retired must still fail. And being listed
    // under Retired is NOT by itself a licence to keep the population row -- only a declared
    // transition tolerates the mismatch, and only while the transition is live.
    const bare = run({ actual: ["a"], declared: ["a", "ghost"] });
    expect(bare.problems.join(" ")).toMatch(/ghost/);
    expect(bare.problems.join(" ")).toMatch(/do NOT exist/);

    const retiredOnly = run({ actual: ["a"], declared: ["a", "ghost"], retired: ["ghost"] });
    expect(retiredOnly.problems.join(" "), "Retired alone must not excuse a live population row").toMatch(/ghost/);
  });

  it("CONTROL: over-crediting a module in more rows than it declares hooks still FAILS", () => {
    const { problems } = run({ actual: ["a"], declared: ["a", "a"], hooks: { a: 1 } });
    expect(problems.join(" ")).toMatch(/more matrix rows than they declare hooks/);
  });
});

describe("vivijure#830 a DECLARED transition tolerates the two-repo window, in both directions", () => {
  it("RETIRING, hub row already gone, module still here: tolerated when Retired records it", () => {
    const { problems, exempt } = run({
      actual: ["a", "kling"],
      declared: ["a"],
      transitions: [{ name: "kling", direction: "retiring", issue: "cf#921" }],
      retired: ["kling"],
    });
    expect(problems).toEqual([]);
    expect([...exempt]).toEqual(["kling"]);
  });

  it("RETIRING, module already gone, hub row still there: tolerated", () => {
    const { problems } = run({
      actual: ["a"],
      declared: ["a", "kling"],
      transitions: [{ name: "kling", direction: "retiring", issue: "cf#921" }],
    });
    expect(problems).toEqual([]);
  });

  it("ADDING, module here first, no row yet: tolerated (this is the half that unblocks a NEW door)", () => {
    const { problems } = run({
      actual: ["a", "newdoor"],
      declared: ["a"],
      transitions: [{ name: "newdoor", direction: "adding", issue: "cf#999" }],
    });
    expect(problems).toEqual([]);
  });

  it("ADDING, row here first, no module yet: tolerated", () => {
    const { problems } = run({
      actual: ["a"],
      declared: ["a", "newdoor"],
      transitions: [{ name: "newdoor", direction: "adding", issue: "cf#999" }],
    });
    expect(problems).toEqual([]);
  });

  it("a transition exempts ONLY its own name, never the rest of the disagreement", () => {
    const { problems } = run({
      actual: ["a", "kling", "orphan"],
      declared: ["a"],
      transitions: [{ name: "kling", direction: "retiring", issue: "cf#921" }],
      retired: ["kling"],
    });
    expect(problems.join(" ")).toMatch(/orphan/);
    expect(problems.join(" ")).not.toMatch(/kling/);
  });
});

describe("vivijure#830 an exemption cannot be left behind, which is what stops it being a hiding place", () => {
  it("a COMPLETED retirement is a hard FAIL, not a silent no-op", () => {
    const { problems } = run({
      actual: ["a"],
      declared: ["a"],
      transitions: [{ name: "kling", direction: "retiring", issue: "cf#921" }],
    });
    expect(problems.join(" ")).toMatch(/retirement is COMPLETE/);
    expect(problems.join(" ")).toMatch(/spent exemption is a standing hole/);
  });

  it("a COMPLETED addition is a hard FAIL too (symmetric)", () => {
    const { problems } = run({
      actual: ["a", "newdoor"],
      declared: ["a", "newdoor"],
      transitions: [{ name: "newdoor", direction: "adding", issue: "cf#999" }],
    });
    expect(problems.join(" ")).toMatch(/addition is COMPLETE/);
  });

  it("a retirement that ERASES the capability instead of recording it FAILS", () => {
    // The failure the gate exists to prevent. A transition entry must not become the quiet way to do
    // it, so a retiring module whose row is gone must be named under Retired.
    const { problems } = run({
      actual: ["a", "kling"],
      declared: ["a"],
      transitions: [{ name: "kling", direction: "retiring", issue: "cf#921" }],
      retired: [],
    });
    expect(problems.join(" ")).toMatch(/not named in the hub's "## Retired" section/);
    expect(problems.join(" ")).toMatch(/instead of erasing the capability/);
  });
});

describe("vivijure#830 parsers fail closed", () => {
  it("parseTransitions accepts a well-formed line and reports every malformed one", () => {
    const ok = parseTransitions("# comment\n\nkling retiring cf#921\n");
    expect(ok.errors).toEqual([]);
    expect(ok.transitions).toEqual([{ name: "kling", direction: "retiring", issue: "cf#921" }]);

    // A lenient parser would DROP these lines, which silently removes an exemption and looks exactly
    // like the gate working. Each must be reported.
    for (const bad of ["kling retiring", "kling sideways cf#921", "kling retiring nope", "Kling retiring cf#921"]) {
      expect(parseTransitions(bad).errors.length, bad).toBeGreaterThan(0);
    }
  });

  it("parseRetiredNames reads the Retired section and NOT the population rows", () => {
    const doc = [
      "| 4 | Motion | `WORKS` | yes | `alive-door` |",
      "",
      "## Retired",
      "",
      "| Capability | Retired | What replaced it |",
      "| --- | --- | --- |",
      "| Something via `dead-door` | 2026-09-27 | Nothing. |",
    ].join("\n");
    const names = parseRetiredNames(doc);
    expect(names).toContain("dead-door");
    // The discriminator: a population name must NOT leak in, or "it is retired" becomes satisfiable
    // by any module mentioned anywhere in the file.
    expect(names).not.toContain("alive-door");
    expect(parseRetiredNames("no heading here `x`")).toEqual([]);
  });

  it("parseMatrixModules still skips prose cells, so the Retired table stays out of the population", () => {
    const { found, rows } = parseMatrixModules(
      [
        "| 1 | Do a thing | `WORKS` | yes | `a`, `b` |",
        "| Something via `dead-door` | 2026-09-27 | Nothing, as a finish step. |",
      ].join("\n"),
    );
    expect(found.sort()).toEqual(["a", "b"]);
    expect(rows).toBe(1);
  });
});
