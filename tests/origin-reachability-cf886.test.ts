/// <reference types="node" />
// cf#886: the DNS reachability report, and the ONE property that must never break.
//
// This check was approved as REPORT-ONLY, explicitly: a release gate that depends on a third party
// being up can block an unrelated release, and the first time it does that it goes on the bypass list
// permanently. So the load-bearing assertion here is not "it finds a bad host" -- it is
// **"it exits 0 no matter what happens"**, including when every host fails and when its own instrument
// is broken. If this file ever has to be relaxed to let a non-zero exit through, the check has become
// the blocking gate that was refused.
//
// NO NETWORK. `localhost` resolves from /etc/hosts and `*.invalid` is reserved by RFC 2606 and never
// resolves, so both answers are deterministic on an offline runner. The resolver is also injectable so
// the instrument-failure paths can be driven without breaking the machine's actual DNS.

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "scripts/report-origin-reachability.sh";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "vivijure-cf886-"));
  scratch.push(d);
  return d;
}

/** Drive the SHIPPED script. Returns status even on success, so every case can assert it. */
function run(tomlText: string | null, env: Record<string, string> = {}): { status: number; out: string } {
  const d = dir();
  let p = join(d, "missing.toml");
  if (tomlText !== null) {
    p = join(d, "wrangler.toml");
    writeFileSync(p, tomlText);
  }
  try {
    const out = execFileSync("sh", [SCRIPT, p], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    return { status: 0, out };
  } catch (e: any) {
    return { status: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

/** A resolver stub: exits with the given code for every host. */
function stubResolver(code: number): string {
  const d = dir();
  const p = join(d, "resolver");
  writeFileSync(p, `#!/bin/sh\nexit ${code}\n`);
  chmodSync(p, 0o755);
  return p;
}

const MIXED = [
  "[vars]",
  'VIDEO_FINISH_URL = "https://localhost"',
  'IMAGE_PREP_URL = "https://nope-cf886.invalid"',
  'FINISH_BLENDER_DOORS = "https://localhost:8080/path,https://also-nope-cf886.invalid"',
  'AUDIO_MIX_URL = ""',
  "",
].join("\n");

describe("cf#886: report-only is the contract, and it is asserted on every path", () => {
  it("2 of 3 hosts unresolvable: reports both, and STILL exits 0", () => {
    const r = run(MIXED);
    expect(r.status).toBe(0); // the whole point
    expect(r.out).toContain("DOES NOT RESOLVE nope-cf886.invalid");
    expect(r.out).toContain("DOES NOT RESOLVE also-nope-cf886.invalid");
    expect(r.out).toContain("RESOLVES        localhost");
    // deduped: localhost appears in two vars and is counted once
    expect(r.out).toMatch(/3 host\(s\) in the media-door values: 1 resolve, 2 do not/);
  });

  it("EVERY host unresolvable: still exits 0", () => {
    const r = run('[vars]\nVIDEO_FINISH_URL = "https://a-cf886.invalid"\nAUDIO_MIX_URL = "https://b-cf886.invalid"\n');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/2 host\(s\).*: 0 resolve, 2 do not/);
    expect(r.out).toContain("The deploy is NOT blocked");
  });

  it("all doors empty is a legitimate state, said out loud rather than printed as nothing", () => {
    const r = run('[vars]\nVIDEO_FINISH_URL = ""\nAUDIO_MIX_URL = ""\n');
    expect(r.status).toBe(0);
    expect(r.out).toContain("0 hosts");
    expect(r.out.trim().length).toBeGreaterThan(0); // an absent report reads exactly like a clean one
  });
});

describe("cf#886: an unmeasured run says so, because absence reads like cleanliness", () => {
  it("no resolver available: UNMEASURED warning, exit 0, and not reported as clean", () => {
    const r = run(MIXED, { RESOLVER: "/nonexistent/resolver-cf886" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("no resolver available");
    expect(r.out).toContain("This is not a clean result");
    // and it must NOT have gone on to print per-host verdicts it could not have obtained
    expect(r.out).not.toContain("RESOLVES");
  });

  it("a resolver that fails on everything is caught by the localhost probe, not reported as 3 dead hosts", () => {
    // The instrument-failure case. Without the probe, a broken resolver would print every host as
    // unresolvable, which looks like a catastrophic outage and is actually a broken tool.
    const r = run(MIXED, { RESOLVER: stubResolver(1) });
    expect(r.status).toBe(0);
    expect(r.out).toContain("could not resolve 'localhost'");
    expect(r.out).toContain("UNMEASURED");
    expect(r.out).not.toContain("DOES NOT RESOLVE nope-cf886.invalid");
  });

  it("a missing rendered config is UNMEASURED, exit 0", () => {
    const r = run(null);
    expect(r.status).toBe(0);
    expect(r.out).toContain("UNMEASURED");
  });

  it("a resolver that succeeds on everything reports every host as resolving", () => {
    // The positive control on the injection seam itself: if the stub were ignored, this would show
    // the .invalid hosts failing and the case below would be measuring nothing.
    const r = run(MIXED, { RESOLVER: stubResolver(0) });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/3 host\(s\).*: 3 resolve, 0 do not/);
  });
});

describe("cf#886: wired next to the var report, and never with the power to refuse", () => {
  const ci = readFileSync(".github/workflows/ci.yml", { encoding: "utf8" });

  it("the deploy render invokes it exactly once, right after the origin-var report", () => {
    const live = ci.split("\n").filter((l) => l.includes(SCRIPT) && !l.trim().startsWith("#"));
    expect(live.length).toBe(1);
    const varsAt = ci.indexOf("sh scripts/report-origin-vars.sh");
    expect(varsAt).toBeGreaterThan(0);
    expect(ci.indexOf(live[0])).toBeGreaterThan(varsAt);
  });

  it("it is NOT invoked with anything that could turn a warning into a failure", () => {
    const live = ci.split("\n").filter((l) => l.includes(SCRIPT) && !l.trim().startsWith("#"))[0];
    // no `|| exit`, no `&&` chain that inverts it, no `set -e` rescue wrapper on the same line
    expect(live).not.toMatch(/\|\||&&|exit/);
    // and the script itself must not carry `set -e`, which would let a failing lookup terminate it
    const body = readFileSync(SCRIPT, { encoding: "utf8" });
    expect(body).not.toMatch(/^set -e/m);
    expect(body).toMatch(/^set -u$/m);
    expect(body.trimEnd().endsWith("exit 0")).toBe(true);
  });
});
