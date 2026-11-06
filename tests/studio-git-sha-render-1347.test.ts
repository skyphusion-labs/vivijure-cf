// cf#1347: every render of wrangler.toml.example stamps STUDIO_GIT_SHA, so GET /api/modules can report
// git_sha. The template gains `STUDIO_GIT_SHA = "${STUDIO_GIT_SHA}"`, and there are four renderers. Each is
// RUN here, not read:
//   - ci.yml's deploy render and deploy.sh: `envsubst "$VARS"` with an explicit list. A var missing from
//     the list survives as a literal ${STUDIO_GIT_SHA}, and ci.yml's fail-closed grep then aborts.
//   - studio-release.yml: a bare envsubst, exported from `git rev-parse HEAD` just before it.
//   - deploy/vivijure_deploy.py render_core_toml: a substitution map.
// An empty value must render STUDIO_GIT_SHA = "", which the route reports as null (studio-identity-1347).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const TEMPLATE = read("wrangler.toml.example");
const SHA = "194c7ac3d1e0f2a4b5c6d7e8f9a0b1c2d3e4f5a6";

/** The shell-format list a renderer hands envsubst, taken from the file itself. */
function varsList(file: string, re: RegExp): string {
  const m = read(file).match(re);
  if (!m) throw new Error(`no VARS list in ${file}`);
  return m[1].replace(/\\\$/g, "$");
}
const CI_VARS = varsList(".github/workflows/ci.yml", /VARS='([^']+)'/);
const DEPLOY_SH_VARS = varsList("deploy.sh", /^VARS="([^"]+)"/m);

function envsubst(vars: string | null, env: Record<string, string>): string {
  const args = vars === null ? [] : [vars];
  return execFileSync("envsubst", args, { input: TEMPLATE, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
}
/** ci.yml's own fail-closed check: no ${ may survive outside a comment line. */
const surviving = (toml: string) => toml.split("\n").filter((l) => !/^\s*#/.test(l) && l.includes("${"));
const line = (toml: string) => toml.split("\n").find((l) => /^STUDIO_GIT_SHA\s*=/.test(l));

describe("STUDIO_GIT_SHA is stamped by every render (cf#1347)", () => {
  it("the template declares it in [vars]", () => {
    const vars = TEMPLATE.slice(TEMPLATE.indexOf("[vars]"));
    expect(vars).toMatch(/^STUDIO_GIT_SHA = "\$\{STUDIO_GIT_SHA\}"$/m);
  });

  for (const [name, vars] of [["ci.yml deploy render", CI_VARS], ["deploy.sh", DEPLOY_SH_VARS]] as const) {
    it(`${name}: lists it, renders the sha, and leaves no placeholder for it`, () => {
      expect(vars.split(/\s+/)).toContain("$STUDIO_GIT_SHA");
      const toml = envsubst(vars, { STUDIO_GIT_SHA: SHA });
      expect(line(toml)).toBe(`STUDIO_GIT_SHA = "${SHA}"`);
      expect(surviving(toml).filter((l) => l.includes("STUDIO_GIT_SHA"))).toEqual([]);
      // Empty renders "" (the route then reports null), never a leftover ${STUDIO_GIT_SHA}.
      expect(line(envsubst(vars, { STUDIO_GIT_SHA: "" }))).toBe('STUDIO_GIT_SHA = ""');
    });
  }

  it("ci.yml sets it from github.sha", () => {
    expect(read(".github/workflows/ci.yml")).toMatch(/^\s+STUDIO_GIT_SHA: \$\{\{ github\.sha \}\}$/m);
  });

  it("studio-release.yml exports the checked-out commit before its bare envsubst", () => {
    const wf = read(".github/workflows/studio-release.yml");
    const exp = wf.indexOf('STUDIO_GIT_SHA="$(git rev-parse HEAD)"; export STUDIO_GIT_SHA');
    const sub = wf.indexOf("envsubst < .wrangler.hosted.toml > wrangler.toml");
    expect(exp).toBeGreaterThan(-1);
    expect(sub).toBeGreaterThan(exp);
    // What that bare envsubst does with it, run for real.
    expect(line(envsubst(null, { STUDIO_GIT_SHA: SHA }))).toBe(`STUDIO_GIT_SHA = "${SHA}"`);
  });

  it("the installer's render_core_toml substitutes it, and empty renders empty", () => {
    const py = (gitSha: string) => execFileSync("python3", ["-I", "-c", [
      "import importlib.util, pathlib, sys",
      "p = pathlib.Path(sys.argv[1]) / 'deploy' / 'vivijure_deploy.py'",
      "spec = importlib.util.spec_from_file_location('vivijure_deploy', p)",
      "vd = importlib.util.module_from_spec(spec); sys.modules['vivijure_deploy'] = vd; spec.loader.exec_module(vd)",
      "t = (pathlib.Path(sys.argv[1]) / 'wrangler.toml.example').read_text()",
      "sys.stdout.write(vd.render_core_toml(t, account_id='0000', d1_id='', store_id='', git_sha=sys.argv[2]))",
    ].join("\n"), ROOT, gitSha], { encoding: "utf8" });
    expect(line(py(SHA))).toBe(`STUDIO_GIT_SHA = "${SHA}"`);
    expect(line(py(""))).toBe('STUDIO_GIT_SHA = ""');
  });
});
