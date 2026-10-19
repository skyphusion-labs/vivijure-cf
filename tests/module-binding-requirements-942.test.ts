// cf#942 / vivijure-control-plane cp#526: the module declares WHAT it needs, and the release
// manifest carries it.
//
// WHY THIS SUITE EXISTS. The plane cannot emit a binding it was never told about, and until now the
// module release manifest carried `{module, main_module, compatibility_date, compatibility_flags,
// worker}` and no bindings at all -- so the array the plane builds at upload WAS the complete
// binding set a tenant module got, derived from a hand-maintained catalog on the other side of a
// repo boundary. `readWorkflows` is what replaces that guess with the module's own declaration, and
// it is a PARSER: it turns a config file into a published contract, so a parser proven only by the
// release that consumes it is proven at the worst possible moment.
//
// The traps are the point. A pattern matching `name\s*=` anywhere in a wrangler.toml picks up the
// worker's own top-level `name`; a block reader that does not stop at the next table header absorbs
// `binding` from the `[[secrets_store_secrets]]` block that follows in six of these files. Both
// produce a plausible wrong answer rather than an error, which is why each has a case below.

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkflows } from "../scripts/build-module-release";

const ROOT = join(import.meta.dirname, "..");
const MODULES = join(ROOT, "modules");

function modulesWithConfig(): string[] {
  return readdirSync(MODULES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .map((e) => e.name)
    .filter((m) => {
      try { readFileSync(join(MODULES, m, "wrangler.toml")); return true; } catch { return false; }
    })
    .sort();
}

/** An INDEPENDENT count of the declaration, so the parser is compared against the file rather than
 *  against itself: count the literal table headers, which no parsing decision can influence. */
function declaredBlockCount(module: string): number {
  return readFileSync(join(MODULES, module, "wrangler.toml"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l === "[[workflows]]").length;
}

const ALL = modulesWithConfig();

function fixture(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cf942-"));
  const path = join(dir, "wrangler.toml");
  writeFileSync(path, body);
  return path;
}

describe("the parser reads the module's own declaration", () => {
  it("CONTROL: the scan found the modules, so every assertion below has a subject", () => {
    expect(ALL.length).toBeGreaterThan(20);
    expect(ALL).toContain("dialogue-gen");
    expect(ALL).not.toContain("no-such-module-cf942");
  });

  it("finds exactly the blocks each real wrangler.toml declares, across the whole tree", () => {
    // Asserted against the independent header count, per module and by name. A total-vs-total
    // comparison would let two errors cancel.
    let withWorkflows = 0;
    for (const m of ALL) {
      const declared = declaredBlockCount(m);
      expect(readWorkflows(join(MODULES, m, "wrangler.toml")), m).toHaveLength(declared);
      if (declared > 0) withWorkflows += 1;
    }
    // DENOMINATOR: a tree where nothing declared a workflow would pass the loop above vacuously.
    expect(withWorkflows).toBeGreaterThan(0);
  });

  it("reads dialogue-gen's triple exactly, values and all", () => {
    // The hosted `dialogue` door, and the reason this change exists. Every field asserted, because
    // a parser that returned the right SHAPE with a wrong class_name would bind a Workflow that
    // does not exist and say nothing.
    expect(readWorkflows(join(MODULES, "dialogue-gen", "wrangler.toml"))).toEqual([
      { binding: "DIALOGUE_WORKFLOW", class_name: "DialogueGenWorkflow", name: "dialogue-gen" },
    ]);
  });

  it("returns NOTHING for a module that declares none, which is a different answer from cannot-say", () => {
    // keyframe is the negative case in the real tree. An empty array means "declares none"; the
    // manifest field being ABSENT is what means "this artifact predates the contract". Collapsing
    // those two is how a module that needs a binding provisions unbound.
    expect(declaredBlockCount("keyframe")).toBe(0);
    expect(readWorkflows(join(MODULES, "keyframe", "wrangler.toml"))).toEqual([]);
  });
});

describe("the traps that produce a plausible WRONG answer rather than an error", () => {
  it("does not absorb the worker's own top-level name", () => {
    const p = fixture(
      'name = "vivijure-module-trap"\nmain = "src/index.ts"\n\n' +
        '[[workflows]]\nname = "trap-wf"\nbinding = "TRAP_WORKFLOW"\nclass_name = "TrapWorkflow"\n',
    );
    expect(readWorkflows(p)).toEqual([
      { binding: "TRAP_WORKFLOW", class_name: "TrapWorkflow", name: "trap-wf" },
    ]);
  });

  it("stops at the next table header, so a following block cannot leak its own `binding`", () => {
    // Six real module configs put [[secrets_store_secrets]] directly after [[workflows]], and that
    // block has a `binding` key of its own.
    const p = fixture(
      '[[workflows]]\nname = "wf"\nbinding = "GOOD"\nclass_name = "Good"\n\n' +
        '[[secrets_store_secrets]]\nbinding = "GATEWAY_ID"\nstore_id = "x"\nsecret_name = "GATEWAY_ID"\n',
    );
    expect(readWorkflows(p)).toEqual([{ binding: "GOOD", class_name: "Good", name: "wf" }]);
  });

  it("ignores a sub-table of its own block rather than reading past it", () => {
    // [workflows.limits] and [workflows.default_retention] are documented Cloudflare syntax.
    //
    // The sub-table below carries a quoted `name`, which is ADVERSARIAL rather than realistic, and
    // deliberately so. With only `steps = 25000` in it this case passed against a header-blind
    // parser as well (the key is not one of the three, and its value is not quoted), so it was a
    // test that could not fail. MEASURED, not assumed: a mutation that dropped the header boundary
    // left this green while the two cases around it went red, and that is what the extra key fixes.
    const p = fixture(
      '[[workflows]]\nname = "wf"\nbinding = "B"\nclass_name = "C"\n\n' +
        '[workflows.limits]\nsteps = 25000\nname = "not-the-workflow"\n\n' +
        '[[workflows]]\nname = "wf2"\nbinding = "B2"\nclass_name = "C2"\n',
    );
    expect(readWorkflows(p)).toEqual([
      { binding: "B", class_name: "C", name: "wf" },
      { binding: "B2", class_name: "C2", name: "wf2" },
    ]);
  });

  it("ignores a COMMENTED-OUT declaration", () => {
    const p = fixture('# [[workflows]]\n# name = "ghost"\n# binding = "GHOST"\n# class_name = "Ghost"\n');
    expect(readWorkflows(p)).toEqual([]);
  });

  it("REFUSES a partial block instead of emitting a smaller one", () => {
    // A requirement missing its class_name is not a lesser requirement, it is an unusable one, and
    // the refusal has to land at BUILD -- not at provision, where the plane binds something wrong,
    // and not at first invoke, where the tenant has already paid for the keyframe pass.
    const p = fixture('[[workflows]]\nname = "wf"\nbinding = "B"\n');
    expect(() => readWorkflows(p)).toThrow(/missing class_name/);
    const q = fixture('[[workflows]]\nclass_name = "C"\n');
    expect(() => readWorkflows(q)).toThrow(/missing binding, name/);
  });

  it("emits a CANONICAL order, so the manifest digest depends on values and not on authoring order", () => {
    // The manifest digest is part of the release pin. Two configs declaring the same requirements in
    // a different order must produce the same bytes.
    const a = fixture(
      '[[workflows]]\nname = "z"\nbinding = "ZED"\nclass_name = "Z"\n\n' +
        '[[workflows]]\nname = "a"\nbinding = "ALPHA"\nclass_name = "A"\n',
    );
    const b = fixture(
      '[[workflows]]\nclass_name = "A"\nbinding = "ALPHA"\nname = "a"\n\n' +
        '[[workflows]]\nclass_name = "Z"\nbinding = "ZED"\nname = "z"\n',
    );
    expect(JSON.stringify(readWorkflows(a))).toBe(JSON.stringify(readWorkflows(b)));
    expect(readWorkflows(a)[0].binding).toBe("ALPHA");
  });
});
