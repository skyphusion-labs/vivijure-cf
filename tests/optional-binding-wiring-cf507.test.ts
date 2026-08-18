/// <reference types="node" />
// Hosted no longer ships Workers VPC on module tomls. Doors are URL vars (*_DOORS).
// This file used to assert every cf482-optional VPC marker was wired through the stripper
// and ci.yml. That population is gone; the load-bearing assertion is now ABSENCE:
// re-adding [[vpc_services]] or REPLACE_WITH_VPC_* / ${VPC_ to a module toml must go red.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const MODULES = join(ROOT, "modules");

function moduleTomls(): { dir: string; text: string }[] {
  const out: { dir: string; text: string }[] = [];
  for (const dir of readdirSync(MODULES)) {
    const toml = join(MODULES, dir, "wrangler.toml");
    if (!existsSync(toml)) continue;
    out.push({ dir, text: readFileSync(toml, "utf8") });
  }
  return out;
}

describe("hosted module tomls carry no Workers VPC", () => {
  it("DENOMINATOR: we actually scan module tomls", () => {
    expect(moduleTomls().length).toBeGreaterThan(0);
  });

  it("no module toml has a live [[vpc_services]] block", () => {
    const hits = moduleTomls()
      .filter((t) => t.text.split("\n").some((l) => /^\s*\[\[vpc_services\]\]/.test(l)))
      .map((t) => t.dir);
    expect(hits).toEqual([]);
  });

  it("no module toml has a live REPLACE_WITH_VPC_* or ${VPC_ placeholder", () => {
    const hits: string[] = [];
    for (const t of moduleTomls()) {
      for (const line of t.text.split("\n")) {
        if (/^\s*#/.test(line)) continue;
        if (/REPLACE_WITH_VPC_|\$\{VPC_/.test(line)) hits.push(`${t.dir}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no module toml still carries a cf482-optional:VPC_* marker", () => {
    const hits = moduleTomls()
      .filter((t) => /cf482-optional:VPC_/.test(t.text))
      .map((t) => t.dir);
    expect(hits).toEqual([]);
  });

  it("Deploy module workers env passes VIDEO_FINISH_URL (not only the core render step)", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const deployMods = ci.split("- name: Deploy module workers")[1];
    const renderCore = ci.split("- name: Render core wrangler.toml")[1];
    expect(deployMods, "Deploy module workers step missing").toBeTruthy();
    expect(renderCore, "Render core wrangler.toml step missing").toBeTruthy();
    const deployEnv = deployMods.split("- name:")[0];
    expect(deployEnv).toMatch(/VIDEO_FINISH_URL:\s*\$\{\{\s*vars\.VIDEO_FINISH_URL\s*\}\}/);
  });

  it("the three door modules declare their DOORS var", () => {
    const need: Record<string, string> = {
      "finish-upscale": "FINISH_UPSCALE_DOORS",
      "speech-upscale": "SPEECH_UPSCALE_DOORS",
      "finish-blender": "FINISH_BLENDER_DOORS",
    };
    for (const [dir, key] of Object.entries(need)) {
      const t = moduleTomls().find((x) => x.dir === dir);
      expect(t, dir + " wrangler.toml missing").toBeTruthy();
      expect(t!.text).toContain(key);
    }
  });
});
