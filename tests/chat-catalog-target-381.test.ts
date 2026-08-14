import { describe, it, expect } from "vitest";
import { resolveCatalogTarget } from "../src/module-catalog";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";

// cf#381: sole-module fallback made ANY model id resolve to the only image.generate module,
// so /api/chat always generated images. These tests pin the fix: only declared ids / module names.

function mod(partial: {
  name: string;
  hooks: string[];
  modelValues?: string[];
}): RegisteredModule {
  return {
    name: partial.name,
    version: "0.0.1",
    api: 2,
    hooks: partial.hooks as RegisteredModule["hooks"],
    provides: [],
    config_schema: partial.modelValues
      ? { model: { type: "enum", values: partial.modelValues, default: partial.modelValues[0] } }
      : {},
    binding: "MODULE_" + partial.name.toUpperCase().replace(/-/g, "_"),
  } as unknown as RegisteredModule;
}

const imageOnly = mod({
  name: "image-generate",
  hooks: ["image.generate"],
  modelValues: ["flux-2-dev", "flux-2-pro"],
});

describe("resolveCatalogTarget image.generate (cf#381)", () => {
  it("resolves a declared image model id", () => {
    const t = resolveCatalogTarget([imageOnly], "image.generate", "flux-2-dev");
    expect(t?.moduleName).toBe("image-generate");
    expect(t?.configModel).toBe("flux-2-dev");
  });

  it("resolves the module name as an alias when the module is known", () => {
    const t = resolveCatalogTarget([imageOnly], "image.generate", "image-generate");
    expect(t?.moduleName).toBe("image-generate");
  });

  it("returns null for a text/LLM model id even when it is the SOLE image module (the prod defect)", () => {
    // Live catalog: one image.generate module. Any string used to win sole-module fallback.
    expect(resolveCatalogTarget([imageOnly], "image.generate", "anthropic/claude-sonnet-5")).toBeNull();
    expect(resolveCatalogTarget([imageOnly], "image.generate", "definitely-not-a-real-model")).toBeNull();
    expect(resolveCatalogTarget([imageOnly], "image.generate", "gpt-4o")).toBeNull();
  });

  it("returns null on blank id", () => {
    expect(resolveCatalogTarget([imageOnly], "image.generate", "   ")).toBeNull();
  });
});
