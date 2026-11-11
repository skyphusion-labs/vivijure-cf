// plan-enhance: Opus over the AI binding, with no CF_AIG_TOKEN (opt-in ENHANCE_OPUS_BINDING=1).
//
// What this file holds, and why each one matters:
//   - The catalog id. The binding resolves a model by its exact AI Gateway catalog name, and the
//     catalog spells Claude versions with a dot ("anthropic/claude-opus-4.8"); the vendor dash form
//     does not resolve. A wrong id is a failed Opus call on every render.
//   - The opt-in. A deployment with GATEWAY_ID and no token runs the free local model today. It must
//     keep doing so unless it opts in, or it would start spending without anyone asking.
//   - The token path is unchanged when a token is set, even with the opt-in.
//   - Attribution and skip-cache reach the binding's gateway options.
//   - A binding error never carries its text (it can echo the user's storyboard, cf#223).

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../modules/plan-enhance/src/index";
import {
  anthropicCatalogId,
  callOpus,
  ModelStoppedError,
  opusTransport,
  pickProvider,
  type ProviderEnv,
} from "../modules/plan-enhance/src/provider";

afterEach(() => vi.unstubAllGlobals());

const OK_REPLY = { content: [{ type: "text", text: "directed" }], stop_reason: "end_turn" };

interface RunCall {
  model: string;
  input: Record<string, unknown>;
  opts: { gateway?: Record<string, unknown> } | undefined;
}

function bindingEnv(extra: Partial<ProviderEnv> = {}, reply: unknown = OK_REPLY, calls: RunCall[] = []): ProviderEnv {
  return {
    AI: {
      run: async (model: string, input: unknown, opts?: { gateway?: Record<string, unknown> }) => {
        calls.push({ model, input: input as Record<string, unknown>, opts: opts as RunCall["opts"] });
        return reply;
      },
      gateway: () => ({ getUrl: async () => "https://gateway.example/v1/acc/gw/anthropic" }),
    } as unknown as ProviderEnv["AI"],
    GATEWAY_ID: "gw",
    ENHANCE_OPUS_BINDING: "1",
    ...extra,
  };
}

/** Any outbound fetch is a failure on the binding path: it would be the token path. */
function forbidFetch() {
  const f = vi.fn(async () => {
    throw new Error("fetch must not be called on the binding path");
  });
  vi.stubGlobal("fetch", f);
  return f;
}

describe("anthropicCatalogId", () => {
  it("maps the vendor slug to the catalog spelling", () => {
    expect(anthropicCatalogId("claude-opus-4-8")).toBe("anthropic/claude-opus-4.8");
    expect(anthropicCatalogId("anthropic/claude-opus-4-8")).toBe("anthropic/claude-opus-4.8");
    expect(anthropicCatalogId("claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4.6");
    expect(anthropicCatalogId("claude-fable-5")).toBe("anthropic/claude-fable-5");
    expect(anthropicCatalogId("claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
  });
  it("returns null for a shape it does not know, rather than guessing", () => {
    for (const bad of ["", "gpt-5", "claude-3-5-sonnet", "claude-opus", "claude-opus-4-8-x", "@cf/meta/x"]) {
      expect(anthropicCatalogId(bad), bad).toBeNull();
    }
  });
});

describe("transport selection", () => {
  const base = { AI: bindingEnv().AI };
  it("the token wins when both are configured, so a deployment with a token is unchanged", () => {
    expect(opusTransport({ ...base, GATEWAY_ID: "gw", CF_AIG_TOKEN: "t", ENHANCE_OPUS_BINDING: "1" })).toBe("token");
    expect(opusTransport({ ...base, GATEWAY_ID: "gw", CF_AIG_TOKEN: "t" })).toBe("token");
  });
  it("binding only when opted in with exactly 1, and only with a gateway", () => {
    expect(opusTransport({ ...base, GATEWAY_ID: "gw", ENHANCE_OPUS_BINDING: "1" })).toBe("binding");
    for (const v of [undefined, "", "0", "true", "yes"]) {
      expect(opusTransport({ ...base, GATEWAY_ID: "gw", ENHANCE_OPUS_BINDING: v }), String(v)).toBeNull();
    }
    expect(opusTransport({ ...base, ENHANCE_OPUS_BINDING: "1" })).toBeNull();
  });
  it("a gateway with no token and no opt-in stays on the local model, as it does today", () => {
    expect(pickProvider({ ...base, GATEWAY_ID: "gw" })).toBe("local");
    expect(pickProvider({ ...base, GATEWAY_ID: "gw", ENHANCE_OPUS_BINDING: "1" })).toBe("opus");
    expect(pickProvider({ ...base, GATEWAY_ID: "gw", ENHANCE_OPUS_BINDING: "1" }, "@cf/meta/x")).toBe("local");
  });
});

describe("callOpus over the binding", () => {
  it("runs the catalog id with an Anthropic Messages body and only the gateway id, and never fetches", async () => {
    const fetchSpy = forbidFetch();
    const calls: RunCall[] = [];
    const text = await callOpus(bindingEnv({}, OK_REPLY, calls), [
      { role: "system", content: "be a director" },
      { role: "user", content: "a harbor" },
    ], undefined, { maxTokens: 777 });
    expect(text).toBe("directed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("anthropic/claude-opus-4.8");
    expect(calls[0].input).toEqual({
      max_tokens: 777,
      system: "be a director",
      messages: [{ role: "user", content: "a harbor" }],
    });
    // Self-hosted: no tenant identity, so no metadata, and no cache flag unless asked.
    expect(calls[0].opts).toEqual({ gateway: { id: "gw" } });
  });

  it("honors a catalog model override and ENHANCE_MODEL", async () => {
    forbidFetch();
    const calls: RunCall[] = [];
    await callOpus(bindingEnv({}, OK_REPLY, calls), [{ role: "user", content: "x" }], "anthropic/claude-sonnet-4-6");
    await callOpus(bindingEnv({ ENHANCE_MODEL: "claude-fable-5" }, OK_REPLY, calls), [{ role: "user", content: "x" }]);
    expect(calls.map((c) => c.model)).toEqual(["anthropic/claude-sonnet-4.6", "anthropic/claude-fable-5"]);
  });

  it("carries tenant attribution as gateway metadata, and skip-cache when asked", async () => {
    forbidFetch();
    const calls: RunCall[] = [];
    await callOpus(
      bindingEnv({ TENANT_ID: "t-123", TENANT_SLUG: "hero" }, OK_REPLY, calls),
      [{ role: "user", content: "x" }],
      undefined,
      { skipCache: true },
    );
    expect(calls[0].opts).toEqual({ gateway: { id: "gw", metadata: { tenant_id: "t-123", slug: "hero" }, skipCache: true } });
  });

  it("refuses a model with no catalog form, so the caller falls back to local", async () => {
    forbidFetch();
    const calls: RunCall[] = [];
    await expect(callOpus(bindingEnv({}, OK_REPLY, calls), [{ role: "user", content: "x" }], "claude-3-5-sonnet")).rejects.toThrow(
      "no catalog id",
    );
    expect(calls).toHaveLength(0);
  });

  it("a binding error is reported by class, never by its text", async () => {
    forbidFetch();
    const env = bindingEnv();
    env.AI.run = async () => {
      throw new TypeError("upstream echoed: SECRET STORYBOARD LINE");
    };
    const err = await callOpus(env, [{ role: "user", content: "x" }]).then(() => null, (e: Error) => e);
    expect(err?.message).toBe("anthropic binding call failed (TypeError)");
    expect(err?.message).not.toContain("STORYBOARD");
  });

  it("a refused or truncated reply is ModelStoppedError, which the caller must not fall back on", async () => {
    forbidFetch();
    await expect(
      callOpus(bindingEnv({}, { content: [], stop_reason: "refusal" }), [{ role: "user", content: "x" }]),
    ).rejects.toBeInstanceOf(ModelStoppedError);
    await expect(
      callOpus(bindingEnv({}, { content: [{ type: "text", text: "half" }], stop_reason: "max_tokens" }), [{ role: "user", content: "x" }]),
    ).rejects.toBeInstanceOf(ModelStoppedError);
  });

  it("with a token set, the token path runs even when opted in: fetch, not the binding", async () => {
    const recorded: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      recorded.push(String(input));
      return new Response(JSON.stringify(OK_REPLY), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const calls: RunCall[] = [];
    await callOpus(bindingEnv({ CF_AIG_TOKEN: "tok" }, OK_REPLY, calls), [{ role: "user", content: "x" }]);
    expect(recorded).toEqual(["https://gateway.example/v1/acc/gw/anthropic/v1/messages"]);
    expect(calls).toHaveLength(0);
  });
});

describe("the module end to end, over its real /invoke contract", () => {
  it("chat mode reaches Opus over the binding with no token, and the reply comes back", async () => {
    forbidFetch();
    const calls: RunCall[] = [];
    const env = bindingEnv({}, { content: [{ type: "text", text: "hello from opus" }], stop_reason: "end_turn" }, calls);
    const res = await worker.fetch(
      new Request("https://module/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook: "plan.enhance",
          input: { storyboard: { scenes: [{ prompt: "a harbor" }] } },
          config: { mode: "chat", message: "hello" },
          context: { project: "t", job_id: "j" },
        }),
      }),
      env as never,
    );
    const body = (await res.json()) as { ok: boolean; output?: { notes?: string[] } };
    expect(body.ok).toBe(true);
    expect(calls.map((c) => c.model)).toEqual(["anthropic/claude-opus-4.8"]);
    expect(JSON.stringify(body)).toContain("hello from opus");
  });
});
