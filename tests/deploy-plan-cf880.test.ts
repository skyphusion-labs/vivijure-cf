/// <reference types="node" />
// cf#880: deploy.sh deploys exactly the modules the core binds, fills every module config, and checks
// the store before any worker ships.
//
// THE DEFECT. deploy.sh kept a hand list of modules (STANDARD_MODULES) and said "a binding can never
// dangle". The list named `kling`, which has no module any more, so step 3 died on the missing toml
// before any deploy ran. It also left out eight modules the core template binds, so a fresh account
// could not deploy the core. And it filled only store_id in module configs, never the D1, R2 S3 or URL
// placeholders. No test ran any of it, because deploy.sh needs a real account.
//
// The decisions now live in scripts/deploy-plan.sh, which needs no network, and these cases drive that
// SHIPPED script and the SHIPPED fill script against the SHIPPED template and module configs.

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const PLAN = join(ROOT, "scripts/deploy-plan.sh");
const FILL = join(ROOT, "scripts/fill-module-placeholders.sh");
const TEMPLATE = join(ROOT, "wrangler.toml.example");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "vivijure-cf880-"));
  scratch.push(d);
  return d;
}

function plan(args: string[]): { status: number; out: string; err: string } {
  try {
    const out = execFileSync("sh", [PLAN, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, out, err: "" };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { status: x.status ?? 1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}
function modules(template: string, sat: 0 | 1, lgpu: 0 | 1, blender: 0 | 1): string[] {
  const r = plan(["modules", template, String(sat), String(lgpu), String(blender)]);
  expect(r.status, r.err).toBe(0);
  return r.out.split("\n").filter(Boolean);
}

/** Every live `service = "vivijure-module-X"` in a stripped toml, read independently of the script. */
function boundIn(toml: string): string[] {
  return [...toml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")
    .matchAll(/^service\s*=\s*"vivijure-module-([a-z0-9-]+)"/gm)].map((m) => m[1]).sort();
}

describe("deploy-plan.sh modules: the deploy list is what the core binds (cf#880)", () => {
  it("equals the module services the stripped core config binds, in every profile", () => {
    for (const [sat, lgpu, blender] of [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]] as const) {
      const stripped = plan(["strip", TEMPLATE, String(sat), String(lgpu), String(blender)]);
      expect(stripped.status).toBe(0);
      expect(modules(TEMPLATE, sat, lgpu, blender)).toEqual(boundIn(stripped.out));
    }
  });

  it("includes the eight modules the old hand list left out, and not the retired kling", () => {
    const std = modules(TEMPLATE, 0, 0, 0);
    for (const m of ["infinitetalk", "chatterbox", "cf-hailuo", "cf-veo", "cf-p-video-avatar", "cf-kling-v4", "cf-minimax-h3", "alibaba-wan-lora"]) {
      expect(std, m).toContain(m);
    }
    expect(std).not.toContain("kling");
  });

  it("every module it names has a config to deploy", () => {
    for (const m of modules(TEMPLATE, 1, 0, 1)) {
      expect(existsSync(join(ROOT, "modules", m, "wrangler.toml")), `modules/${m}/wrangler.toml`).toBe(true);
    }
  });

  it("finish-blender binds only when its endpoint id is set, in either profile (DP-18)", () => {
    expect(modules(TEMPLATE, 0, 0, 0)).not.toContain("finish-blender");
    expect(modules(TEMPLATE, 1, 0, 0)).not.toContain("finish-blender");
    expect(modules(TEMPLATE, 0, 0, 1)).toContain("finish-blender");
    expect(modules(TEMPLATE, 1, 0, 1)).toContain("finish-blender");
  });

  it("SATELLITE_MODULES in deploy.sh is exactly what the satellites profile adds", () => {
    const m = /^SATELLITE_MODULES="([^"]*)"/m.exec(readFileSync(join(ROOT, "deploy.sh"), "utf8"));
    expect(m).not.toBeNull();
    const declared = m![1].split(/\s+/).filter(Boolean).sort();
    const std = new Set(modules(TEMPLATE, 0, 0, 0));
    const added = modules(TEMPLATE, 1, 0, 0).filter((x) => !std.has(x)).sort();
    expect(declared).toEqual(added);
  });

  it("CONTROL: each marker kind is stripped and kept by its own flag", () => {
    const d = dir();
    const t = join(d, "t.toml");
    const block = (marker: string, name: string) =>
      `# >>> ${marker}: ${name}\n[[services]]\nbinding = "M"\nservice = "vivijure-module-${name}"\n# <<< ${marker}: ${name}\n`;
    writeFileSync(t, [
      '[[services]]\nbinding = "A"\nservice = "vivijure-module-always"\n',
      '# service = "vivijure-module-commented"\n',
      '[[services]]\nbinding = "T"\nservice = "vivijure-tail"\n',
      block("SELFHOST-SKIP", "fleet"), block("SATELLITE", "sat"), block("LOCAL-GPU", "lgpu"), block("BLENDER", "blend"),
    ].join("\n"));
    expect(modules(t, 0, 0, 0)).toEqual(["always"]);
    expect(modules(t, 1, 0, 0)).toEqual(["always", "sat"]);
    expect(modules(t, 0, 1, 0)).toEqual(["always", "lgpu"]);
    expect(modules(t, 0, 0, 1)).toEqual(["always", "blend"]);
    expect(modules(t, 1, 1, 1)).toEqual(["always", "blend", "lgpu", "sat"]);
  });
});

describe("deploy.sh is wired to the plan, not to a hand list (cf#880)", () => {
  const sh = readFileSync(join(ROOT, "deploy.sh"), "utf8");
  it("derives MODULES and strips the core with the same flags", () => {
    expect(sh).not.toMatch(/^STANDARD_MODULES=/m);
    expect(sh).toContain('MODULES="$(sh scripts/deploy-plan.sh modules wrangler.toml.example "$KEEP_SAT" "$KEEP_LGPU" "$KEEP_BLENDER"');
    expect(sh).toContain('sh scripts/deploy-plan.sh strip wrangler.toml.example "$KEEP_SAT" "$KEEP_LGPU" "$KEEP_BLENDER" > .wrangler.stage.toml');
  });
  it("fills each module on a rendered copy and deploys that copy", () => {
    expect(sh).toContain('sh scripts/fill-module-placeholders.sh "modules/$m/.deploy.wrangler.toml"');
    expect(sh).toContain('until $WR deploy -c "modules/$m/.deploy.wrangler.toml"; do');
    expect(sh).not.toMatch(/sed -i -E "s\/store_id[^\n]*"\$f"/);
  });
  it("checks the store before step 6, the first step that changes the account after seeding", () => {
    const check = sh.indexOf("sh scripts/deploy-plan.sh missing");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(sh.indexOf('say "Step 6/9'));
    expect(check).toBeLessThan(sh.indexOf('say "Step 7/9'));
  });
});

describe("every module deploy.sh ships fills cleanly (cf#880)", () => {
  it("leaves no placeholder in any rendered module config", () => {
    const d = dir();
    const env = {
      ...process.env,
      SECRETS_STORE_ID: "store_cf880", D1_DATABASE_ID: "d1_cf880", CLOUDFLARE_ACCOUNT_ID: "acct_cf880",
      R2_S3_BUCKET: "vivijure",
    };
    const names = modules(TEMPLATE, 1, 0, 1);
    expect(names.length).toBeGreaterThan(25);
    for (const m of names) {
      const copy = join(d, `${m}.toml`);
      cpSync(join(ROOT, "modules", m, "wrangler.toml"), copy);
      let status = 0;
      let out = "";
      try {
        execFileSync("sh", [FILL, copy], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
      } catch (e) {
        const x = e as { status?: number; stdout?: string; stderr?: string };
        status = x.status ?? 1;
        out = `${x.stdout ?? ""}${x.stderr ?? ""}`;
      }
      expect(status, `${m}: ${out}`).toBe(0);
      const live = readFileSync(copy, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      expect(live, m).not.toMatch(/REPLACE_WITH_|\$\{[A-Z_]+\}/);
    }
  });
});

describe("deploy-plan.sh secrets and missing (cf#880)", () => {
  function tomls(): { a: string; b: string; d: string } {
    const d = dir();
    const a = join(d, "a.toml");
    const b = join(d, "b.toml");
    writeFileSync(a, '[[secrets_store_secrets]]\nbinding = "X"\nsecret_name = "CF_AIG_TOKEN"\n# secret_name = "COMMENTED_OUT"\n');
    writeFileSync(b, '[[secrets_store_secrets]]\nsecret_name = "FINISH_DOOR_TOKEN"\n[[secrets_store_secrets]]\nsecret_name = "CF_AIG_TOKEN"\n');
    return { a, b, d };
  }
  it("lists each live binding with the config that holds it, and skips a comment", () => {
    const { a, b } = tomls();
    const r = plan(["secrets", a, b]);
    expect(r.status).toBe(0);
    expect(r.out.trim().split("\n").sort()).toEqual([`CF_AIG_TOKEN ${a}`, `CF_AIG_TOKEN ${b}`, `FINISH_DOOR_TOKEN ${b}`].sort());
  });
  it("reports nothing and exits 0 when the store holds every bound secret", () => {
    const { a, b, d } = tomls();
    const list = join(d, "list");
    writeFileSync(list, "id1 CF_AIG_TOKEN\nid2 FINISH_DOOR_TOKEN\n");
    expect(plan(["missing", list, a, b])).toMatchObject({ status: 0, out: "" });
  });
  it("names a missing secret and exits 3, and is word-exact", () => {
    const { a, b, d } = tomls();
    const list = join(d, "list");
    // PLAN_ENHANCE_CF_AIG_TOKEN must not count as CF_AIG_TOKEN.
    writeFileSync(list, "id1 PLAN_ENHANCE_CF_AIG_TOKEN\nid2 FINISH_DOOR_TOKEN\n");
    const r = plan(["missing", list, a, b]);
    expect(r.status).toBe(3);
    expect(r.out.trim()).toBe("CF_AIG_TOKEN");
  });
  it("an empty store listing is could-not-measure (exit 2), not nothing missing", () => {
    const { a, d } = tomls();
    const list = join(d, "list");
    writeFileSync(list, "");
    expect(plan(["missing", list, a]).status).toBe(2);
  });
  it("the real core config binds the two secrets no other step of deploy.sh seeds", () => {
    const stripped = plan(["strip", TEMPLATE, "0", "0", "0"]);
    const d = dir();
    const core = join(d, "core.toml");
    writeFileSync(core, stripped.out);
    const names = plan(["secrets", core]).out.split("\n").map((l) => l.split(" ")[0]);
    expect(names).toContain("FINISH_DOOR_TOKEN");
    expect(names).toContain("BACKEND_RUNPOD_WAN_TRAIN_ENDPOINT_ID");
    const example = readFileSync(join(ROOT, "deploy.env.example"), "utf8");
    expect(example).toMatch(/^FINISH_DOOR_TOKEN=$/m);
    expect(example).toMatch(/^BACKEND_RUNPOD_WAN_TRAIN_ENDPOINT_ID=$/m);
  });
});

describe("deploy.env.example tells the truth about a failed planner token mint (cf#880, DP-17)", () => {
  it("says the deploy stops, not that it completes", () => {
    const example = readFileSync(join(ROOT, "deploy.env.example"), "utf8");
    expect(example).not.toContain("the deploy still\n# completes");
    expect(example).toContain("the deploy STOPS before any worker ships");
    expect(readFileSync(join(ROOT, "deploy.sh"), "utf8")).toContain('die "CF_AIG_TOKEN is required before deploy');
  });
});
