// cf#1134: a plan cut off at max_tokens was reported as a storyboard validation failure, and a
// retry replayed the same truncated body from the AI Gateway cache.
//
// These run the REAL path: planStoryboard -> real registry -> real plan-enhance worker -> real
// callOpus + parsePlanStoryboard. The only stub is the outbound fetch to the gateway, which answers
// with the Anthropic body shape recorded in gateway log 01a18ff2-fa49.

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../modules/plan-enhance/src/index";
import { planStoryboard, refineStoryboard, chatComplete } from "../src/planner";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import type { Env } from "../src/env";

const MODEL = "anthropic/claude-sonnet-5";
const CUT_JSON = '{"title":"Long Film","scenes":[{"prompt":"a wide shot of a harbor at d';
const GOOD = { title: "Good", scenes: [{ prompt: "a wide shot of a quiet harbor at dawn" }] };

function truncated() {
  return {
    content: [
      { type: "thinking", thinking: "", signature: "x" },
      { type: "text", text: CUT_JSON },
    ],
    stop_reason: "max_tokens",
    usage: { output_tokens: 4096, output_tokens_details: { thinking_tokens: 2396 } },
  };
}
function complete(text: string, stop_reason = "end_turn") {
  return { content: [{ type: "text", text }], stop_reason, usage: { output_tokens: 10 } };
}

interface Sent {
  headers: Record<string, string>;
  body: { max_tokens?: number };
}

/** Stub the gateway fetch, recording what was sent. A Workers AI call is recorded separately, so a
 *  test can prove the local fallback did or did not run. */
function setup(reply: unknown, status = 200) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Sent["body"],
      });
      return new Response(JSON.stringify(reply), { status });
    }),
  );
  const localCalls: unknown[] = [];
  const moduleEnv = {
    AI: {
      run: async (m: string) => {
        localCalls.push(m);
        return { response: JSON.stringify(GOOD) };
      },
      gateway: () => ({ getUrl: async () => "https://gw.example/anthropic" }),
    },
    GATEWAY_ID: "gw",
    CF_AIG_TOKEN: "tok",
  };
  const env = {
    MODULE_PLANENHANCE: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        worker.fetch(new Request(input, init), moduleEnv as never),
    },
  } as unknown as Env;
  return { env, sent, localCalls, moduleEnv };
}

async function invokeDirect(moduleEnv: unknown, config: Record<string, unknown>, storyboard: unknown) {
  const res = await worker.fetch(
    new Request("https://module/invoke", {
      method: "POST",
      body: JSON.stringify({
        hook: "plan.enhance",
        input: { storyboard },
        config,
        context: { project: "t", job_id: "j" },
      }),
    }),
    moduleEnv as never,
  );
  return (await res.json()) as
    | { ok: true; output: { storyboard: unknown; notes?: string[] } }
    | { ok: false; error: string };
}

afterEach(() => {
  vi.unstubAllGlobals();
  _resetModuleDiscoveryCache();
});

describe("cf#1134 a truncated reply is reported, never parsed", () => {
  it("plan: the studio states truncation, not storyboard validation errors", async () => {
    const { env, localCalls } = setup(truncated());
    const r = await planStoryboard(env, { brief: "a long film", characters: [], model: MODEL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("max_tokens");
    expect(r.errors[0]).toContain("2396 thinking");
    expect(r.errors.join()).not.toMatch(/title is required|scenes is required/);
    expect(r.raw).toBeNull();
    // The cut text never reaches the caller (cf#223), and the weaker model did not paper over it.
    expect(JSON.stringify(r)).not.toContain("harbor");
    expect(localCalls).toEqual([]);
  });

  it("a truncated reply whose text happens to be complete JSON is still not a plan", async () => {
    // Without the stop_reason check this parses and ships, which is why the check cannot be
    // replaced by relying on the parser to choke on cut JSON.
    const { env } = setup({ ...complete(JSON.stringify(GOOD)), stop_reason: "max_tokens" });
    const r = await planStoryboard(env, { brief: "a long film", characters: [], model: MODEL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("max_tokens");
  });

  it("refine: a truncated reply fails instead of returning the input as a success", async () => {
    const { env } = setup(truncated());
    const r = await refineStoryboard(env, { storyboard: GOOD, message: "make it night", model: MODEL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("max_tokens");
  });

  it("chat: a truncated reply is a failure, not partial text presented as the answer", async () => {
    const { env } = setup(truncated());
    const r = await chatComplete(env, { model: MODEL, user_input: "suggest a track" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("max_tokens");
  });

  it("enhance keeps its honest passthrough degrade and names truncation", async () => {
    const { moduleEnv, localCalls } = setup(truncated());
    const r = await invokeDirect(moduleEnv, { model: MODEL }, GOOD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output.storyboard).toEqual(GOOD);
    expect(r.output.notes?.[0]).toContain("enhancement skipped");
    expect(r.output.notes?.[0]).toContain("max_tokens");
    expect(localCalls).toEqual([]);
  });

  it("a refusal is reported and is not retried on the fallback model", async () => {
    const { env, localCalls } = setup({ content: [], stop_reason: "refusal" });
    const r = await planStoryboard(env, { brief: "x", characters: [], model: MODEL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("refused");
    expect(localCalls).toEqual([]);
  });
});

describe("cf#1134 plan and refine failures are real failures with the true reason", () => {
  it("plan: an unparseable reply states that, not validation errors", async () => {
    const { env } = setup(complete("Sorry, here is a plan in prose."));
    const r = await planStoryboard(env, { brief: "x", characters: [], model: MODEL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("not valid storyboard JSON");
    expect(r.errors.join()).not.toMatch(/title is required|scenes is required/);
    expect(JSON.stringify(r)).not.toContain("in prose"); // cf#223
  });

  it("refine: an unparseable reply fails rather than passing the input through as a success", async () => {
    const { env } = setup(complete("no json here"));
    const r = await refineStoryboard(env, { storyboard: GOOD, message: "x", model: MODEL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("not valid storyboard JSON");
  });

  it("plan: when both providers fail the error names both, with no upstream prose", async () => {
    const { env, moduleEnv } = setup(
      { error: { type: "overloaded_error", message: "SECRET-UPSTREAM-PROSE" } },
      529,
    );
    moduleEnv.AI.run = async () => {
      throw new Error("workers ai down");
    };
    const r = await planStoryboard(env, { brief: "x", characters: [], model: MODEL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("anthropic 529 (overloaded_error)");
    expect(r.errors[0]).toContain("workers ai down");
    expect(JSON.stringify(r)).not.toContain("SECRET-UPSTREAM-PROSE");
  });

  it("a fallback that succeeds still says why it fell back", async () => {
    const { moduleEnv, localCalls } = setup({ error: { type: "overloaded_error" } }, 529);
    const r = await invokeDirect(moduleEnv, { mode: "plan", message: "x", model: MODEL }, { scenes: [] });
    expect(localCalls).toHaveLength(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.notes?.[0]).toContain("opus fell back: anthropic 529 (overloaded_error)");
  });
});

describe("cf#1134 output budget", () => {
  it("plan, refine and enhance send the long budget; chat keeps 4096", async () => {
    const { env, sent, moduleEnv } = setup(complete(JSON.stringify(GOOD)));
    await planStoryboard(env, { brief: "x", characters: [], model: MODEL });
    await refineStoryboard(env, { storyboard: GOOD, message: "x", model: MODEL });
    await invokeDirect(moduleEnv, { model: MODEL }, GOOD);
    await chatComplete(env, { model: MODEL, user_input: "x" });
    expect(sent.map((s) => s.body.max_tokens)).toEqual([21000, 21000, 21000, 4096]);
  });

  it("the long budget stays under the SDK non-streaming ceiling", async () => {
    // @anthropic-ai/sdk _calculateNonstreamingTimeout: 3600 s * max_tokens / 128000 must be <= 600 s.
    const { env, sent } = setup(complete(JSON.stringify(GOOD)));
    await planStoryboard(env, { brief: "x", characters: [], model: MODEL });
    expect((3600 * sent[0].body.max_tokens!) / 128000).toBeLessThanOrEqual(600);
  });
});

describe("cf#1134 a plan never reads the gateway cache", () => {
  it("plan and refine send cf-aig-skip-cache; enhance and chat do not", async () => {
    const { env, sent, moduleEnv } = setup(complete(JSON.stringify(GOOD)));
    await planStoryboard(env, { brief: "x", characters: [], model: MODEL });
    await refineStoryboard(env, { storyboard: GOOD, message: "x", model: MODEL });
    await invokeDirect(moduleEnv, { model: MODEL }, GOOD);
    await chatComplete(env, { model: MODEL, user_input: "x" });
    expect(sent.map((s) => s.headers["cf-aig-skip-cache"])).toEqual(["true", "true", undefined, undefined]);
  });
});
