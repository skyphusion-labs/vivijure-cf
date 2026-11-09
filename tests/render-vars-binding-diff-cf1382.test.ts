/// <reference types="node" />
// cf#1382: the tag deploy's two new controls, each driven in BOTH directions against the SHIPPED
// scripts, never a re-implementation of them.
//
//   - scripts/assert-render-vars.sh: a variable the template uses that renders EMPTY goes red,
//     unless it is on the allow-list. The control is the live shape: every used name set except the
//     three empty by design, which stays green.
//   - scripts/studio-bindings-snapshot.mjs: a binding that changes across the deploy goes red, and a
//     STUDIO_GIT_SHA stamp alone does not. A snapshot that could not be read exits 2, never 0.

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- a plain .mjs script, no declaration file
import { normalizeBindings, diffSnapshots } from "../scripts/studio-bindings-snapshot.mjs";

const GUARD = "scripts/assert-render-vars.sh";
const SNAP = "scripts/studio-bindings-snapshot.mjs";
const TEMPLATE = "wrangler.toml.example";
const CI = readFileSync(".github/workflows/ci.yml", "utf8");
const ALLOW = "ACCESS_AUD ACCESS_TEAM_DOMAIN FINISH_UPSCALE_DOORS";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "vivijure-cf1382-"));
  scratch.push(d);
  return d;
}

/** The VARS list the deploy job's render step really uses, read from ci.yml. */
function ciVars(): string {
  const m = CI.match(/^ {10}VARS='([^']+)'$/m);
  if (!m) throw new Error("VARS line not found in ci.yml");
  return m[1];
}

/** Names the template reads outside comments. */
function usedNames(): string[] {
  const body = readFileSync(TEMPLATE, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  return [...new Set([...body.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))].sort();
}

const SENTINEL = "sentinel-value-must-not-print";

/** Every used name set to the sentinel, then the overrides applied (undefined = unset). */
function liveEnv(over: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  for (const n of usedNames()) env[n] = SENTINEL;
  for (const n of ALLOW.split(" ")) env[n] = "";
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function guard(env: NodeJS.ProcessEnv, vars = ciVars(), template = TEMPLATE): { status: number; out: string } {
  try {
    const out = execFileSync("sh", [GUARD, template, vars], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, out };
  } catch (e: any) {
    return { status: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

describe("assert-render-vars.sh (cf#1382)", () => {
  it("the template and the CI list agree on enough names to measure", () => {
    const listed = ciVars().split(/\s+/).map((v) => v.replace(/^\$/, ""));
    const used = usedNames().filter((n) => listed.includes(n));
    expect(used).toEqual(expect.arrayContaining(["VIDEO_FINISH_URL", "KEYFRAME_PARALLEL", "PANEL_HOME"]));
  });

  it("CONTROL: the live shape (only the allow-listed three empty) passes", () => {
    const r = guard({ ...liveEnv({}), RENDER_EMPTY_ALLOW: ALLOW });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/\d+ used, empty by allow-list:/);
    for (const n of ALLOW.split(" ")) expect(r.out).toContain(n);
    expect(r.out).not.toContain("::error::");
  });

  for (const name of ["VIDEO_FINISH_URL", "KEYFRAME_PARALLEL", "PANEL_HOME"]) {
    it(`an UNSET ${name} fails (the 2026-11-09 shape)`, () => {
      const r = guard({ ...liveEnv({ [name]: undefined }), RENDER_EMPTY_ALLOW: ALLOW });
      expect(r.status).toBe(1);
      expect(r.out).toContain(`::error::${name} would render EMPTY`);
    });
  }

  it("a SET-but-empty value fails the same as an unset one", () => {
    const r = guard({ ...liveEnv({ VIDEO_FINISH_URL: "" }), RENDER_EMPTY_ALLOW: ALLOW });
    expect(r.status).toBe(1);
    expect(r.out).toContain("VIDEO_FINISH_URL would render EMPTY");
  });

  it("without the allow-list, the three empty-by-design names fail too", () => {
    const r = guard(liveEnv({}));
    expect(r.status).toBe(1);
    for (const n of ALLOW.split(" ")) expect(r.out).toContain(`::error::${n} would render EMPTY`);
  });

  it("the allow-list excuses only its own names", () => {
    const r = guard({ ...liveEnv({ PANEL_HOME: "" }), RENDER_EMPTY_ALLOW: ALLOW });
    expect(r.status).toBe(1);
    expect(r.out).toContain("PANEL_HOME would render EMPTY");
    expect(r.out).not.toContain("ACCESS_AUD would render EMPTY");
  });

  it("a listed name the template never reads (VPC_*) is not checked", () => {
    const r = guard({ ...liveEnv({ VPC_VIDEO_FINISH_ID: "" }), RENDER_EMPTY_ALLOW: ALLOW });
    expect(r.status).toBe(0);
  });

  it("never prints a value", () => {
    const r = guard({ ...liveEnv({ PANEL_HOME: "" }), RENDER_EMPTY_ALLOW: ALLOW });
    expect(r.out).not.toContain(SENTINEL);
  });

  it("refuses to pass when it measured nothing", () => {
    const d = dir();
    const t = join(d, "t.toml");
    writeFileSync(t, 'name = "x"\n# ${VIDEO_FINISH_URL} only in a comment\n');
    const r = guard(liveEnv({}), ciVars(), t);
    expect(r.status).toBe(2);
  });

  it("ci.yml runs it with the reviewed allow-list, before envsubst, in the deploy job", () => {
    const call = `RENDER_EMPTY_ALLOW='${ALLOW}' sh scripts/assert-render-vars.sh .wrangler.hosted.toml "$VARS"`;
    const at = CI.indexOf(call);
    expect(at).toBeGreaterThan(CI.indexOf("\n  deploy:\n"));
    expect(at).toBeLessThan(CI.indexOf('envsubst "$VARS" < .wrangler.hosted.toml > wrangler.toml'));
    expect(CI.split("scripts/assert-render-vars.sh").length - 1).toBe(1);
  });
});

const B = (over: Record<string, string> = {}) => [
  { type: "plain_text", name: "KEYFRAME_PARALLEL", text: over.KEYFRAME_PARALLEL ?? "2" },
  { type: "plain_text", name: "STUDIO_GIT_SHA", text: over.STUDIO_GIT_SHA ?? "aaaa" },
  { type: "plain_text", name: "VIDEO_FINISH_URL", text: over.VIDEO_FINISH_URL ?? "https://video-finish.example.invalid" },
  { type: "secret_text", name: "STUDIO_API_TOKEN" },
  { type: "service", name: "MODULE_KEYFRAME", service: "vivijure-module-keyframe", environment: "production" },
  { type: "d1", name: "DB", id: "d1-id" },
  { type: "durable_object_namespace", name: "FINISH", class_name: "FinishContainer" },
];

describe("studio-bindings-snapshot.mjs (cf#1382)", () => {
  it("sorts, shows plain_text text, never a secret, and masks STUDIO_GIT_SHA", () => {
    const lines = normalizeBindings(B());
    expect(lines).toEqual([...lines].sort());
    expect(lines).toContain("plain_text\tKEYFRAME_PARALLEL\t2");
    expect(lines).toContain("plain_text\tSTUDIO_GIT_SHA\t<stamped>");
    expect(lines).toContain("secret_text\tSTUDIO_API_TOKEN\t");
    expect(lines).toContain('service\tMODULE_KEYFRAME\t{"environment":"production","service":"vivijure-module-keyframe"}');
    expect(lines).toContain('durable_object_namespace\tFINISH\t{"class_name":"FinishContainer"}');
  });

  it("CONTROL: a new STUDIO_GIT_SHA alone is no difference", () => {
    const d = diffSnapshots(normalizeBindings(B()), normalizeBindings(B({ STUDIO_GIT_SHA: "bbbb" })));
    expect(d).toEqual({ removed: [], added: [] });
  });

  it("a defaulted KEYFRAME_PARALLEL (2 to 4) is a difference", () => {
    const d = diffSnapshots(normalizeBindings(B()), normalizeBindings(B({ KEYFRAME_PARALLEL: "4" })));
    expect(d.removed).toEqual(["plain_text\tKEYFRAME_PARALLEL\t2"]);
    expect(d.added).toEqual(["plain_text\tKEYFRAME_PARALLEL\t4"]);
  });

  it("a removed binding is a difference", () => {
    const d = diffSnapshots(normalizeBindings(B()), normalizeBindings(B().filter((b) => b.name !== "DB")));
    expect(d.removed).toEqual(['d1\tDB\t{"id":"d1-id"}']);
  });

  function cli(args: string[], env: NodeJS.ProcessEnv = { PATH: process.env.PATH }): { status: number; out: string } {
    try {
      const out = execFileSync("node", [SNAP, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, out };
    } catch (e: any) {
      return { status: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
    }
  }

  it("--diff exits 0 on equal snapshots and 1 on a changed one, naming the line", () => {
    const d = dir();
    const a = join(d, "a"), b = join(d, "b"), c = join(d, "c");
    writeFileSync(a, normalizeBindings(B()).join("\n") + "\n");
    writeFileSync(b, normalizeBindings(B({ STUDIO_GIT_SHA: "bbbb" })).join("\n") + "\n");
    writeFileSync(c, normalizeBindings(B({ VIDEO_FINISH_URL: "" })).join("\n") + "\n");
    expect(cli(["--diff", a, b]).status).toBe(0);
    const r = cli(["--diff", a, c]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("+ plain_text\tVIDEO_FINISH_URL\t");
  });

  it("an empty or missing snapshot is could-not-measure (2), never equal", () => {
    const d = dir();
    const e = join(d, "empty");
    writeFileSync(e, "");
    expect(cli(["--diff", e, e]).status).toBe(2);
    expect(cli(["--diff", join(d, "nope"), join(d, "nope")]).status).toBe(2);
  });

  it("a snapshot with no credential exits 2 and writes nothing", () => {
    const d = dir();
    const r = cli([join(d, "out")]);
    expect(r.status).toBe(2);
    expect(r.out).toContain("could not measure");
  });

  it("ci.yml snapshots before the core deploy and diffs after the gate self-check", () => {
    const deployJob = CI.indexOf("\n  deploy:\n");
    const before = CI.indexOf("- name: Snapshot live studio bindings (before)");
    const deploy = CI.indexOf("- name: Deploy core worker");
    const gate = CI.indexOf("- name: Post-deploy gate self-check");
    const after = CI.indexOf("- name: Live studio bindings unchanged (cf#1382)");
    expect(deployJob).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(deployJob);
    expect(before).toBeLessThan(deploy);
    expect(after).toBeGreaterThan(gate);
    expect(CI).toContain('node scripts/studio-bindings-snapshot.mjs --diff "$RUNNER_TEMP/studio-bindings-before.txt" "$RUNNER_TEMP/studio-bindings-after.txt"');
  });
});
