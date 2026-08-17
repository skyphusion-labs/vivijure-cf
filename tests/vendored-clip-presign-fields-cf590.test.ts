/// <reference types="node" />
// cf#590 / core#183: clip-level modules vendor FinishInput / SpeechInput. A field core adds is
// invisible to those copies on a dependency bump. This gate reads core's interface and fails when a
// vendor has not mirrored a new `*_url` / `output_key` field.
//
// Parse the named interface body, not the whole file: FinishArtifactsDecl also declares
// `output_key`, and a file-level grep would stay green on a copy that never mirrored the input.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = join(ROOT, "modules");

function resolveCoreTypes(): string {
  const req = createRequire(join(ROOT, "package.json"));
  const pkgDir = dirname(req.resolve("@skyphusion-labs/vivijure-core/package.json"));
  const candidates = [
    join(pkgDir, "src", "modules", "types.ts"),
    join(pkgDir, "dist", "modules", "types.d.ts"),
  ];
  const hit = candidates.find((p) => existsSync(p));
  expect(hit, "core FinishInput/SpeechInput types not found under node_modules").toBeTruthy();
  return hit!;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function interfaceBody(src: string, name: string): string {
  const re = new RegExp(`(?:export\\s+)?interface\\s+${name}\\b`);
  const m = re.exec(src);
  expect(m, `interface ${name} not found`).toBeTruthy();
  const brace = src.indexOf("{", m!.index);
  expect(brace, `interface ${name} has no body`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(brace + 1, i);
    }
  }
  throw new Error(`interface ${name} unclosed`);
}

function fieldNames(body: string): string[] {
  const names: string[] = [];
  for (const line of stripComments(body).split("\n")) {
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/);
    if (m) names.push(m[1]);
  }
  return names;
}

function presignFields(names: string[]): string[] {
  return names.filter((n) => n === "output_key" || /_url$/.test(n)).sort();
}

function contractVendors(interfaceName: string): { name: string; src: string }[] {
  return readdirSync(MODULES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .flatMap((e) => {
      const path = join(MODULES, e.name, "src", "contract.ts");
      if (!existsSync(path)) return [];
      const src = readFileSync(path, "utf8");
      return new RegExp(`(?:export\\s+)?interface\\s+${interfaceName}\\b`).test(src)
        ? [{ name: e.name, src }]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const coreSrc = readFileSync(resolveCoreTypes(), "utf8");
const coreFinishPresign = presignFields(fieldNames(interfaceBody(coreSrc, "FinishInput")));
const coreSpeechPresign = presignFields(fieldNames(interfaceBody(coreSrc, "SpeechInput")));
const finishVendors = contractVendors("FinishInput");
const speechVendors = contractVendors("SpeechInput");

describe("vendored clip-level presign fields (cf#590)", () => {
  it("core FinishInput still declares the five clip-level presigned fields", () => {
    expect(coreFinishPresign.length, "parser found no FinishInput url/output_key fields").toBeGreaterThan(0);
    expect(coreFinishPresign).toEqual(
      expect.arrayContaining(["audio_url", "hash_url", "output_key", "output_url", "video_url"]),
    );
  });

  it("core SpeechInput still declares the speech url fields", () => {
    expect(coreSpeechPresign.length, "parser found no SpeechInput url/output_key fields").toBeGreaterThan(0);
    expect(coreSpeechPresign).toEqual(
      expect.arrayContaining(["audio_url", "output_key", "output_url"]),
    );
  });

  it("the clip-level FinishInput vendors are the four finish doors", () => {
    expect(finishVendors.map((v) => v.name)).toEqual([
      "finish-blender",
      "finish-lipsync",
      "finish-rife",
      "finish-upscale",
    ]);
  });

  it("the SpeechInput vendor is speech-upscale", () => {
    expect(speechVendors.map((v) => v.name)).toEqual(["speech-upscale"]);
  });

  it("FinishArtifactsDecl output_key is not mistaken for FinishInput (negative control)", () => {
    const rife = finishVendors.find((v) => v.name === "finish-rife");
    expect(rife, "finish-rife contract missing").toBeTruthy();
    const artifactFields = fieldNames(interfaceBody(rife!.src, "FinishArtifactsDecl"));
    expect(artifactFields).toContain("output_key");
    expect(fieldNames(interfaceBody(rife!.src, "FinishInput"))).toContain("output_key");
  });

  for (const vendor of finishVendors) {
    it(`${vendor.name} FinishInput is a superset of core FinishInput presign fields`, () => {
      const have = new Set(fieldNames(interfaceBody(vendor.src, "FinishInput")));
      const missing = coreFinishPresign.filter((f) => !have.has(f));
      expect(missing, `${vendor.name} missing core FinishInput fields: ${missing.join(", ")}`).toEqual([]);
    });
  }

  for (const vendor of speechVendors) {
    it(`${vendor.name} SpeechInput is a superset of core SpeechInput presign fields`, () => {
      const have = new Set(fieldNames(interfaceBody(vendor.src, "SpeechInput")));
      const missing = coreSpeechPresign.filter((f) => !have.has(f));
      expect(missing, `${vendor.name} missing core SpeechInput fields: ${missing.join(", ")}`).toEqual([]);
    });
  }
});
