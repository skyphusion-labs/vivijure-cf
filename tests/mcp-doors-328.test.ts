// cf#328: two Studio MCP doors share this repo's wrangler configs; only production is CI-deployed.
//
// The propagandhi door (wrangler.mcp.propagandhi.toml, script vivijure-studio-mcp-flatliners) is
// intentional and hand-deployed (fleet secrets). A hand-deployed worker has no automatic redeploy,
// so the defect that filed this issue was "three weeks stale and serverInfo 0.1.0" with nothing to
// flag it. This test is the package-level drift detector:
//
//   1. both tracked MCP wrangler configs point at @skyphusion-labs/vivijure-mcp (not a stale fork
//      path, not vivijure-core's old mcp.js entry);
//   2. the installed package's wire serverInfo.version matches its package.json version (the
//      hardcoded 0.1.0 bug vivijure-mcp v1.1.0 fixed -- if the pin regresses, we fail here).
//
// It cannot see the LIVE Cloudflare bundle without fleet API tokens. After a pin bump, redeploy
// the propagandhi door by hand (docs/mcp.md). Production stays on the tag CI path unchanged.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MCP_PKG = "@skyphusion-labs/vivijure-mcp";
const MCP_MAIN = `node_modules/${MCP_PKG}/dist/mcp.js`;

const DOORS: { file: string; role: string }[] = [
  { file: "wrangler.mcp.toml.example", role: "production template (CI-rendered)" },
  { file: "wrangler.mcp.propagandhi.toml", role: "propagandhi / local (hand-deployed)" },
];

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function mainFromToml(toml: string): string | null {
  const m = toml.match(/^\s*main\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

function nameFromToml(toml: string): string | null {
  const m = toml.match(/^\s*name\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

describe("cf#328 MCP doors (package identity + serverInfo pin)", () => {
  it("both wrangler configs point at the same vivijure-mcp entry", () => {
    for (const d of DOORS) {
      expect(existsSync(join(ROOT, d.file)), `${d.file} missing (${d.role})`).toBe(true);
      const toml = read(d.file);
      const main = mainFromToml(toml);
      expect(main, `${d.file} main=`).toBe(MCP_MAIN);
    }
  });

  it("production template and propagandhi door keep distinct script names", () => {
    // A shared script name would make a hand redeploy of propagandhi overwrite production MCP.
    const prod = nameFromToml(read("wrangler.mcp.toml.example"));
    const prop = nameFromToml(read("wrangler.mcp.propagandhi.toml"));
    expect(prod).toBe("vivijure-studio-mcp");
    expect(prop).toBe("vivijure-studio-mcp-flatliners");
    expect(prod).not.toBe(prop);
  });

  it("propagandhi config documents intentional hand-deploy (cf#328 disposition)", () => {
    const toml = read("wrangler.mcp.propagandhi.toml");
    expect(toml).toMatch(/cf#328|cf#328/i);
    expect(toml).toMatch(/hand[- ]deploy/i);
    expect(toml).toMatch(/NOT CI-deployed|not CI-deployed/i);
    expect(toml).toMatch(/vivijure-local\.skyphusion\.org/);
  });

  it("installed vivijure-mcp serverInfo.version matches package.json version", () => {
    // The wire-version defect: serverInfo sat at 0.1.0 while package.json said 1.x, so an agent
    // probing serverInfo.version could not tell tools had landed. vivijure-mcp pins them equal;
    // this asserts the INSTALLED pin in this repo still does.
    const pkgPath = join(ROOT, "node_modules", MCP_PKG, "package.json");
    const distPath = join(ROOT, "node_modules", MCP_PKG, "dist", "mcp.js");
    expect(existsSync(pkgPath), "vivijure-mcp not installed").toBe(true);
    expect(existsSync(distPath), "vivijure-mcp dist missing").toBe(true);

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    const dist = readFileSync(distPath, "utf8");
    // SERVER_INFO = { name: "...", version: "X.Y.Z" } -- accept either quote style / spacing.
    const m = dist.match(/SERVER_INFO\s*=\s*\{[^}]*version:\s*["']([^"']+)["']/);
    expect(m, "SERVER_INFO.version not found in dist/mcp.js").not.toBeNull();
    expect(m![1]).toBe(pkg.version);
    // Sanity: not the pre-fix 0.1.0 that left the live door lying.
    expect(pkg.version).not.toBe("0.1.0");
    expect(m![1]).not.toBe("0.1.0");
  });

  it("package.json depends on vivijure-mcp (the door entry package)", () => {
    const root = JSON.parse(read(join("package.json"))) as {
      dependencies?: Record<string, string>;
    };
    expect(root.dependencies?.[MCP_PKG]).toBeTruthy();
  });
});
