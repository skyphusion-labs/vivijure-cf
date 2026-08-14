// cf#294 -- vivijure-tail's wrangler.toml.example must remain the SOURCE of a real render, not a
// document that drifts from the live Worker. PR #309 shipped scripts/deploy-tail.sh; this guard
// pins that the example, the script, and the gitignore stay wired together so the automation half
// cannot silently regress to "hand-edited only".

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";

const EXAMPLE = "tail/wrangler.toml.example";
const SCRIPT = "scripts/deploy-tail.sh";
const GITIGNORE = ".gitignore";

function src(path: string): string {
  return readFileSync(path, "utf8");
}

describe("cf#294: vivijure-tail config is rendered from the committed example", () => {
  it("the example, script, and gitignore all exist", () => {
    expect(existsSync(EXAMPLE), `${EXAMPLE} missing`).toBe(true);
    expect(existsSync(SCRIPT), `${SCRIPT} missing -- re-introduce the render path from PR #309`).toBe(true);
    expect(existsSync(GITIGNORE)).toBe(true);
  });

  it("the example injects LOKI_VPC_ID and never hardcodes account_id", () => {
    const ex = src(EXAMPLE);
    expect(ex).toMatch(/service_id\s*=\s*"\$\{LOKI_VPC_ID\}"/);
    expect(ex).toMatch(/name\s*=\s*"vivijure-tail"/);
    expect(ex).toMatch(/binding\s*=\s*"LOKI_VPC"/);
    // account_id stays out of the file (CLOUDFLARE_ACCOUNT_ID env), same as the core.
    expect(ex).not.toMatch(/^\s*account_id\s*=/m);
  });

  it("deploy-tail.sh renders the example via envsubst and fails closed on missing env", () => {
    const sh = src(SCRIPT);
    expect(sh).toContain("wrangler.toml.example");
    expect(sh).toContain("envsubst");
    expect(sh).toContain("LOKI_VPC_ID");
    expect(sh).toMatch(/unsubstituted placeholder|LOKI_VPC_ID rendered empty/);
    // Executable for operators (chmod +x is part of the control).
    accessSync(SCRIPT, constants.X_OK);

    // Fail-closed smoke: with env vars stripped, the script must die before wrangler deploy.
    // Use a clean env so a developer's shell credentials cannot make this pass vacuously.
    const r = spawnSync("bash", [SCRIPT], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" },
      encoding: "utf8",
    });
    expect(r.status, `expected non-zero exit; stdout=${r.stdout} stderr=${r.stderr}`).not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/CLOUDFLARE_ACCOUNT_ID|required but unset/);
  });

  it(".gitignore stops tracking the rendered tail/wrangler.toml, and does not ignore the example (cf#529)", () => {
    // A substring match on GITIGNORE's source text is satisfied by a comment that merely MENTIONS
    // the path, so it cannot tell "there is a rule" from "there is a sentence" -- cf#529, same
    // class as core#190. `git check-ignore` answers the effective question instead: it is immune
    // to comments and to rule ordering, and goes red if the rule is removed OR if a real ignore
    // rule for the example is ever added (the exact regression this guard exists to catch).
    //
    // `--no-index` is not optional here, and it is the second half of the same defect class:
    // tail/wrangler.toml.example is a TRACKED file, and `git check-ignore` without `--no-index`
    // reports a tracked path as "not ignored" regardless of whether a pattern matches it, because
    // gitignore rules are moot for a path already in the index. Verified live: planting a real
    // `tail/wrangler.toml.example` rule in .gitignore left the index-aware form reporting exit 1
    // (not ignored) UNCHANGED -- the exact false pass this guard exists to prevent, reproduced by
    // the fix that was supposed to close it. `--no-index` evaluates the pattern against the raw
    // path and correctly reports exit 0 once that rule is added.
    const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", "tail/wrangler.toml"]);
    expect(ignored.status, "tail/wrangler.toml must be ignored").toBe(0);
    const notIgnored = spawnSync("git", ["check-ignore", "-q", "--no-index", "tail/wrangler.toml.example"]);
    expect(notIgnored.status, "tail/wrangler.toml.example must NOT be ignored").not.toBe(0);
  });
});
