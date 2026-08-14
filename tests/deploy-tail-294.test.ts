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

  it(".gitignore stops tracking the rendered tail/wrangler.toml", () => {
    const gi = src(GITIGNORE);
    expect(gi).toMatch(/\/tail\/wrangler\.toml/);
    expect(gi).toMatch(/tail\/wrangler\.toml\.example/);
  });
});
