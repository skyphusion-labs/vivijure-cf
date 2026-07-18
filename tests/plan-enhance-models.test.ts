// plan.enhance model selection (cf#62): the module maps catalog ids to gateway model slugs and
// picks its provider from the id, so the studio never has to know either.

import { describe, expect, it } from "vitest";
import worker from "../modules/plan-enhance/src/index";
import {
  opusModel,
  pickProvider,
  DEFAULT_OPUS_MODEL,
  LOCAL_MODEL,
  type ProviderEnv,
} from "../modules/plan-enhance/src/provider";

const stubEnv = (over: Partial<ProviderEnv> = {}): ProviderEnv =>
  ({ AI: { run: async () => ({}), gateway: () => ({ getUrl: async () => "" }) }, ...over });

const GATEWAY = stubEnv({ GATEWAY_ID: "skyphusion-llm", CF_AIG_TOKEN: "tok" });

describe("plan.enhance anthropic model ids", () => {
  it("maps catalog ids to gateway model slugs (strips the anthropic/ prefix)", () => {
    expect(opusModel(GATEWAY, "anthropic/claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(opusModel(GATEWAY, "anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(opusModel(GATEWAY, "anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("accepts a bare gateway slug unchanged", () => {
    expect(opusModel(GATEWAY, "claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("covers every id the SERVED manifest declares", async () => {
    // Guards the drift this whole issue exists to kill: a value in the manifest enum that the
    // provider cannot actually map is a catalog entry that breaks when a user picks it.
    //
    // Read off the manifest the worker actually SERVES on GET /module.json -- that is the artifact
    // the studio projects the catalog from. Asserting against a re-declared copy would only prove
    // the copy agrees with itself.
    const res = await worker.fetch(
      new Request("https://module/module.json"),
      {} as never,
    );
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as {
      config_schema: { model: { type: string; values: string[]; default: string } };
    };
    const field = manifest.config_schema.model;

    expect(field.type).toBe("enum");
    expect(field.values.length).toBeGreaterThan(0);
    expect(field.values).toContain("anthropic/claude-sonnet-5");
    // the declared default must itself be a declared value
    expect(field.values).toContain(field.default);

    for (const id of field.values) {
      expect(opusModel(GATEWAY, id)).toBe(id.replace(/^anthropic\//, ""));
      expect(pickProvider(GATEWAY, id)).toBe("opus");
    }
  });

  it("falls back to ENHANCE_MODEL, then the default, with no override", () => {
    expect(opusModel(GATEWAY)).toBe(DEFAULT_OPUS_MODEL);
    expect(opusModel(stubEnv({ ...GATEWAY, ENHANCE_MODEL: "claude-opus-4-6" }))).toBe("claude-opus-4-6");
    expect(opusModel(stubEnv({ ...GATEWAY, ENHANCE_MODEL: "anthropic/claude-opus-4-6" }))).toBe("claude-opus-4-6");
  });

  it("ignores a NON-anthropic override rather than sending it to the anthropic endpoint", () => {
    // A "@cf/..." id is a Workers AI model; pickProvider routes it local, so opusModel must not
    // smuggle it into the gateway body.
    expect(opusModel(GATEWAY, "@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe(DEFAULT_OPUS_MODEL);
  });
});

describe("plan.enhance provider selection", () => {
  it("routes a Workers AI id local even when the gateway is fully configured", () => {
    expect(pickProvider(GATEWAY, "@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe("local");
  });

  it("routes an anthropic id to opus when configured, local when not", () => {
    expect(pickProvider(GATEWAY, "anthropic/claude-opus-4-8")).toBe("opus");
    expect(pickProvider(stubEnv(), "anthropic/claude-opus-4-8")).toBe("local");
  });

  it("keeps the old no-override behaviour", () => {
    expect(pickProvider(GATEWAY)).toBe("opus");
    expect(pickProvider(stubEnv())).toBe("local");
    expect(pickProvider(stubEnv({ GATEWAY_ID: "g" }))).toBe("local");
  });

  it("LOCAL_MODEL is the declared free fallback", () => {
    expect(LOCAL_MODEL).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });
});
