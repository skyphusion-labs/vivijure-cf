/// <reference types="node" />
// Hosted studio never binds MuseTalk. Homelab still can (wrangler.toml.example SATELLITE).

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "scripts/strip-finish-lipsync.sh";
const TEMPLATE = "wrangler.toml.example";
const WORKFLOW_DIR = ".github/workflows";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vivijure-nolipsync-"));
  scratch.push(d);
  return d;
}

function strip(inputText: string): { status: number; stdout: string; stderr: string; out: string } {
  const dir = scratchDir();
  const inPath = join(dir, "in.toml");
  const outPath = join(dir, "out.toml");
  writeFileSync(inPath, inputText);
  try {
    const stdout = execFileSync("sh", [SCRIPT, inPath, outPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "", out: readFileSync(outPath, "utf8") };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    let out = "";
    try {
      out = readFileSync(outPath, "utf8");
    } catch {
      /* refuse before write */
    }
    return {
      status: err.status ?? 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
      out,
    };
  }
}

function hostedRenderWorkflows(): { name: string; text: string }[] {
  const all = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const hits: { name: string; text: string }[] = [];
  for (const name of all) {
    const text = readFileSync(join(WORKFLOW_DIR, name), "utf8");
    const namesTemplate = text.includes(TEMPLATE);
    const writesWranglerToml = />\s*wrangler\.toml\b/.test(text);
    if (namesTemplate || writesWranglerToml) hits.push({ name, text });
  }
  return hits;
}

function invokesStrip(text: string): boolean {
  return text.split("\n").some((line) => line.trim().startsWith(`sh ${SCRIPT} `));
}

const template = readFileSync(TEMPLATE, "utf8");

describe("hosted studio does not bind MuseTalk", () => {
  it("CONTROL: the template strip removes exactly one MODULE_ line and MODULE_LIPSYNC", () => {
    const before = (template.match(/MODULE_/g) ?? []).length;
    expect(before).toBeGreaterThan(1);
    const r = strip(template);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/delta 1, as required/);
    expect(r.out).not.toContain("MODULE_LIPSYNC");
    expect((r.out.match(/MODULE_/g) ?? []).length).toBe(before - 1);
    expect(r.out.length).toBeGreaterThan(template.length * 0.8);
  });

  it("the template carries exactly one SATELLITE finish-lipsync marker pair with the binding", () => {
    const open = (template.match(/^# >>> SATELLITE: finish-lipsync/gm) ?? []).length;
    const close = (template.match(/^# <<< SATELLITE: finish-lipsync/gm) ?? []).length;
    expect(open).toBe(1);
    expect(close).toBe(1);
    const block = /^# >>> SATELLITE: finish-lipsync[\s\S]*?^# <<< SATELLITE: finish-lipsync/m.exec(template)?.[0] ?? "";
    expect(block).toContain("MODULE_LIPSYNC");
    expect(block).toMatch(/HOMELAB|self-host/i);
  });

  it("every hosted wrangler render path calls the strip", () => {
    const paths = hostedRenderWorkflows();
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(invokesStrip(p.text), p.name).toBe(true);
    }
  });
});
