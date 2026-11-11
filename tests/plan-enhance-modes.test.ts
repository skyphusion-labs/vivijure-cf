// plan.enhance planning modes (cf#62): the module now serves the studio's three planner entry
// points (plan / refine / chat) in addition to its original director pass ("enhance").
//
// A MODEL miss on plan/refine is a real failure with the true reason (cf#1134): there is no plan to
// pass through. Malformed I/O (a missing config.message) fails loud too.

import { describe, expect, it } from "vitest";
import worker from "../modules/plan-enhance/src/index";

const STORYBOARD = { scenes: [{ prompt: "a quiet harbor at dawn" }] };
const PLANNED = { title: "Planned", scenes: [{ prompt: "a wide establishing shot" }] };

/** Invoke the module worker over its real HTTP contract. */
async function invoke(
  config: Record<string, unknown>,
  env: Record<string, unknown> = {},
  input: unknown = { storyboard: STORYBOARD },
) {
  const res = await worker.fetch(
    new Request("https://module/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook: "plan.enhance",
        input,
        config,
        context: { project: "t", job_id: "j" },
      }),
    }),
    env as never,
  );
  return (await res.json()) as
    | { ok: true; output: { storyboard: unknown; notes?: string[] } }
    | { ok: false; error: string };
}

/** An AI stub whose gateway/run pair returns a canned reply, or throws. */
function aiEnv(reply: unknown, opts: { gateway?: boolean; throws?: boolean } = {}) {
  const env: Record<string, unknown> = {
    AI: {
      run: async () => {
        if (opts.throws) throw new Error("workers ai down");
        return { response: reply };
      },
      gateway: () => ({ getUrl: async () => "https://gw.example/anthropic" }),
    },
  };
  if (opts.gateway) {
    env.GATEWAY_ID = "gw";
    env.CF_AIG_TOKEN = "tok";
  }
  return env;
}

describe("plan.enhance mode routing", () => {
  it("defaults to the original enhance behaviour when no mode is given", async () => {
    const r = await invoke({ intensity: "medium" }, aiEnv(JSON.stringify(["a directed harbor shot"])));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.notes?.[0]).toContain("enhanced 1 shot(s)");
  });

  it("plan mode returns the model's storyboard", async () => {
    const r = await invoke({ mode: "plan", message: "make me a film" }, aiEnv(JSON.stringify(PLANNED)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.storyboard).toEqual(PLANNED);
      expect(r.output.notes?.[0]).toContain("plan via");
    }
  });

  it("refine mode returns the model's storyboard", async () => {
    const r = await invoke({ mode: "refine", message: "make it night" }, aiEnv(JSON.stringify(PLANNED)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.storyboard).toEqual(PLANNED);
  });

  it("plan mode accepts a fenced ```json reply", async () => {
    const fenced = "```json\n" + JSON.stringify(PLANNED) + "\n```";
    const r = await invoke({ mode: "plan", message: "go" }, aiEnv(fenced));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.storyboard).toEqual(PLANNED);
  });

  it("chat mode returns the reply text as a note", async () => {
    const r = await invoke({ mode: "chat", message: "hello" }, aiEnv("hi there"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.notes).toEqual(["hi there"]);
  });
});

describe("plan.enhance plan-mode misses are real failures (cf#1134)", () => {
  it("fails with the reason when the model errors on plan", async () => {
    const r = await invoke({ mode: "plan", message: "go" }, aiEnv(null, { throws: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("plan.enhance plan failed: workers ai down");
  });

  it("fails with the reason when the reply is not valid storyboard JSON", async () => {
    const r = await invoke({ mode: "plan", message: "go" }, aiEnv("I'm afraid I can't do that"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("was not valid storyboard JSON");
      expect(r.error).not.toContain("afraid"); // cf#223: no model text in an error
    }
  });

  it("fails when the model returns no reply at all", async () => {
    const r = await invoke({ mode: "plan", message: "go" }, aiEnv(undefined));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("returned no reply");
  });
});

describe("plan.enhance director pass keeps its honest degrade", () => {
  it("passes the storyboard through UNCHANGED with a note when the model errors", async () => {
    const r = await invoke({}, aiEnv(null, { throws: true }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.storyboard).toEqual(STORYBOARD);
      expect(r.output.notes?.[0]).toContain("enhancement skipped: model error");
    }
  });
});

describe("plan.enhance malformed I/O fails loud", () => {
  it("rejects plan/refine with no config.message", async () => {
    for (const mode of ["plan", "refine"]) {
      const r = await invoke({ mode }, aiEnv("x"));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(`config.message required for mode ${mode}`);
    }
  });

  it("rejects chat with no config.message", async () => {
    const r = await invoke({ mode: "chat" }, aiEnv("x"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("config.message required for chat mode");
  });

  it("rejects a missing storyboard", async () => {
    const r = await invoke({ mode: "plan", message: "go" }, aiEnv("x"), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("input.storyboard required");
  });

  it("rejects an unsupported hook", async () => {
    const res = await worker.fetch(
      new Request("https://module/invoke", {
        method: "POST",
        body: JSON.stringify({ hook: "finish", input: {}, config: {}, context: {} }),
      }),
      {} as never,
    );
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("unsupported hook");
  });
});

describe("plan.enhance dev mock (#411) survived the move into the module", () => {
  const MOCK = { PLANNER_AI_MOCK: "1", AI: { run: async () => ({}), gateway: () => ({ getUrl: async () => "" }) } };

  it("plans without any model call", async () => {
    const r = await invoke({ mode: "plan", message: "a harbor film" }, MOCK);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.notes?.[0]).toContain("dev-mock");
      expect((r.output.storyboard as { scenes: unknown[] }).scenes.length).toBeGreaterThan(0);
    }
  });

  it("honours the #mock-fail sentinel (drives the validator reject branch)", async () => {
    const r = await invoke({ mode: "plan", message: "a film #mock-fail" }, MOCK);
    expect(r.ok).toBe(true);
    // the reject-branch storyboard is returned as-is; the STUDIO's validator is what rejects it
    if (r.ok) expect((r.output.storyboard as { title?: string }).title).toContain("reject branch");
  });

  it("honours the #mock-badjson sentinel (fails with the reason, does not crash)", async () => {
    const r = await invoke({ mode: "plan", message: "a film #mock-badjson" }, MOCK);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("was not valid storyboard JSON");
  });

  it("is OFF by default -- an unset gate does not reach the mock", async () => {
    const r = await invoke({ mode: "plan", message: "a harbor film" }, aiEnv(JSON.stringify(PLANNED)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.notes?.[0]).not.toContain("dev-mock");
  });
});
