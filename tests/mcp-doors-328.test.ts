// cf#328: production Studio MCP door identity + retired propagandhi door stays gone.
//
// The second door (wrangler.mcp.propagandhi.toml, script vivijure-studio-mcp-flatliners,
// hostname studio-mcp-propagandhi.skyphusion.org) was deleted 2026-08-17 on Conrad apply
// word. This test is the package-level detector:
//
//   1. the production wrangler template points at @skyphusion-labs/vivijure-mcp;
//   2. the installed package's wire serverInfo.version matches its package.json version
//      (the hardcoded 0.1.0 bug vivijure-mcp v1.1.0 fixed);
//   3. the retired propagandhi config is not reintroduced.
//
// It cannot see the LIVE Cloudflare bundle without fleet API tokens. Production stays on
// the tag CI path.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MCP_PKG = "@skyphusion-labs/vivijure-mcp";
const MCP_MAIN = `node_modules/${MCP_PKG}/dist/mcp.js`;
const PROD_TOML = "wrangler.mcp.toml.example";
const RETIRED_TOML = "wrangler.mcp.propagandhi.toml";

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

describe("cf#328 MCP doors (package identity + retired second door)", () => {
  it("production wrangler template points at the vivijure-mcp entry", () => {
    expect(existsSync(join(ROOT, PROD_TOML)), `${PROD_TOML} missing`).toBe(true);
    const toml = read(PROD_TOML);
    expect(mainFromToml(toml), `${PROD_TOML} main=`).toBe(MCP_MAIN);
    expect(nameFromToml(toml)).toBe("vivijure-studio-mcp");
  });

  it("retired propagandhi wrangler config is not in the tree", () => {
    expect(existsSync(join(ROOT, RETIRED_TOML))).toBe(false);
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
