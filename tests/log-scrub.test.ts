// CONTENT-FREE-BY-CONSTRUCTION LOGS (cf#223 stage 1).
//
// WHAT THIS FILE HAS TO AVOID BEING. "Assert the log line does not contain the project name" is
// UNFALSIFIABLE when the fixture is called `test-project`: the string is absent for boring reasons
// (nothing logs it, the harness captured nothing, the name collides with nothing) and the test
// passes just as happily against a completely UNSCRUBBED logger. That is the fake-hash shape, in a
// privacy claim, which is the worst place for it.
//
// SO: SENTINELS + A CONTROL.
//   - every piece of user content in a fixture is a SENTINEL that cannot arrive by any other route
//     (a marker string that appears nowhere in the source tree);
//   - the assertion is that no sentinel appears in ANY captured line, on any channel;
//   - and a CONTROL test deliberately logs a sentinel and asserts the harness SEES it. Without the
//     control, "no sentinel captured" and "the harness captures nothing" are the same observation,
//     and the whole file would pass with the capture wired to nowhere.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { keyLabel, shortId, untrustedLabel } from "../src/log-scrub";
import { generateOpenAIImage, generateImageBytes } from "../modules/image-generate/src/image-gen";
import { callOpus } from "../modules/plan-enhance/src/provider";

/**
 * Markers that can ONLY have come from the content path. Deliberately not words that appear in the
 * codebase, in a route template, or in an error string: a sentinel that could arrive by another
 * route would make an assertion about it meaningless.
 */
const S = {
  project: "SENTINEL7PROJECT4b1e9a-my-divorce-film",
  key: "SENTINEL7KEY4b1e9a",
  voice: "SENTINEL7VOICE4b1e9a",
  prompt: "SENTINEL7PROMPT4b1e9a",
} as const;
const ALL_SENTINELS = Object.values(S);

interface Captured { channel: string; text: string }

function captureConsole(): { lines: Captured[]; restore: () => void } {
  const lines: Captured[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const grab = (channel: string) => (...args: unknown[]) => {
    lines.push({ channel, text: args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
  };
  console.log = grab("log") as typeof console.log;
  console.warn = grab("warn") as typeof console.warn;
  console.error = grab("error") as typeof console.error;
  console.info = grab("info") as typeof console.info;
  return { lines, restore: () => Object.assign(console, original) };
}

let cap: ReturnType<typeof captureConsole>;
beforeEach(() => { cap = captureConsole(); });
afterEach(() => { cap.restore(); });

/** Every captured line, joined. Asserted against as ONE haystack so a leak on any channel fails. */
const haystack = (): string => cap.lines.map((l) => `${l.channel}: ${l.text}`).join("\n");

function expectNoSentinels(): void {
  const all = haystack();
  for (const sentinel of ALL_SENTINELS) {
    expect(all, `sentinel ${sentinel} reached a log line:\n${all}`).not.toContain(sentinel);
  }
}

describe("the capture harness itself", () => {
  it("CONTROL: a sentinel logged on purpose IS captured, on every channel", () => {
    console.log(S.project);
    console.warn(S.key);
    console.error(new Error(`boom ${S.prompt}`));
    console.info(JSON.stringify({ voice: S.voice }));

    const all = haystack();
    // Without this, every "sentinel absent" assertion in this file would also pass with the capture
    // wired to nothing at all.
    for (const sentinel of ALL_SENTINELS) {
      expect(all, `the harness must SEE ${sentinel} when something logs it`).toContain(sentinel);
    }
    expect(cap.lines.map((l) => l.channel).sort()).toEqual(["error", "info", "log", "warn"]);
  });
});

describe("router error lines carry the route TEMPLATE, never the pathname (cf#223)", () => {
  it("a throwing route logs its template, and the sentinel-bearing URL never appears", async () => {
    // The artifact route is the sharpest case: its pathname IS an R2 key, and an R2 key carries the
    // project name (`renders/<project>/clips/...`, `bundles/<projectName>-<hash>.tar.gz`).
    const env = {
      R2_RENDERS: {
        get: () => { throw new Error("R2 exploded"); },
        head: () => { throw new Error("R2 exploded"); },
      },
      ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
      ALLOW_UNAUTHENTICATED: "true",
    } as unknown as Parameters<typeof worker.fetch>[1];

    const url = `https://studio.example/api/artifact/renders/${S.project}/clips/${S.key}.mp4`;
    const res = await worker.fetch(new Request(url), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);

    // The route did fail (this test is worthless if the error path never ran).
    expect(res.status).toBe(500);
    const errorLine = cap.lines.find((l) => l.text.includes("router.error"));
    expect(errorLine, `no router.error line was captured:\n${haystack()}`).toBeDefined();
    // POSITIVE: the template is there, so the line is still diagnosable.
    expect(errorLine!.text).toContain("/api/artifact/*key");
    expectNoSentinels();
  });
});

/*
 * THIS BLOCK USED TO TEST A FILE NOTHING IMPORTS.
 *
 * cf#223 hardened `src/providers/openai-image.ts` and this block asserted against THAT copy. But
 * that file had no production importer: its only referents in the whole tree were this import and
 * one line of docs/privacy-residual-dataset.md. The LIVE OpenAI image path is
 * modules/image-generate/src/image-gen.ts, and it still interpolated the provider prose verbatim.
 *
 * So the gate was green for its entire life over an unguarded path, one directory away. That is the
 * shape this suite exists to refuse, appearing in the suite itself. The dead copy is deleted and
 * these assertions now run against every LIVE site that reads a provider body, enumerated by sweep
 * rather than by memory: the two in image-generate and the one in plan-enhance.
 *
 * Each test drives a provider error whose prose QUOTES THE USER PROMPT BACK, which is the real shape
 * of a moderation refusal on all three providers, and asserts the sentinel reaches neither the
 * thrown message nor any log channel.
 */
describe("provider errors do not carry provider prose (cf#223, LIVE module paths)", () => {
  /** The thrown message from `fn`, or "" if it did not throw. */
  async function messageFrom(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  it("image-generate, OpenAI direct (BYOK): a refusal quoting the prompt does not reach the exception", async () => {
    // The real shape of an OpenAI image refusal: `error.message` quotes the user's prompt.
    const body = {
      error: {
        message: `Your request was rejected as a result of our safety system. Your prompt "${S.prompt}" may contain content that is not allowed.`,
        type: "invalid_request_error",
        code: "moderation_blocked",
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 400 })) as unknown as typeof fetch;
    let message = "";
    try {
      message = await messageFrom(() => generateOpenAIImage("sk-test", "openai/gpt-image-1", S.prompt));
    } finally {
      globalThis.fetch = originalFetch;
    }
    // POSITIVE: still diagnosable. The status and the provider's own ENUMERATED code survive,
    // because they are drawn from a fixed set and cannot carry content.
    expect(message, "the call did not throw at all").not.toBe("");
    expect(message).toContain("400");
    expect(message).toContain("moderation_blocked");
    // NEGATIVE: the prose does not.
    expect(message, "the provider prose quotes the user prompt back").not.toContain(S.prompt);
    expectNoSentinels();
  });

  it("image-generate, AI Gateway proxied: a provider error field quoting the prompt does not reach the exception", async () => {
    // detectProviderFailure() lifts `result.error ?? result.message` STRAIGHT out of the AI.run
    // result, which is a provider body. This is the second live site in the same module and it was
    // never covered.
    const env = {
      AI: {
        run: async () => ({
          error: `Prompt rejected: "${S.prompt}" violates policy.`,
        }),
      },
    } as unknown as Parameters<typeof generateImageBytes>[0];
    const message = await messageFrom(() =>
      generateImageBytes(env, { model: "google/nano-banana-2", prompt: S.prompt }),
    );
    expect(message, "the call did not throw at all").not.toBe("");
    // POSITIVE: the operator still learns the generation was refused by the provider.
    expect(message.toLowerCase()).toContain("failed");
    expect(message, "the provider error field quotes the user prompt back").not.toContain(S.prompt);
    expectNoSentinels();
  });

  it("plan-enhance, Anthropic: 300 chars of raw error body do not reach the exception", async () => {
    // callOpus read `await resp.text()` and interpolated the first 300 characters. An Anthropic
    // 400 echoes the offending request content, and this module's input IS the user's storyboard.
    // Worse than the image path: plan-enhance is PROVISIONED to tenants and two of its three
    // callers fold the exception message into `output.notes`, which is persisted and rendered.
    const env = {
      GATEWAY_ID: "gw-test",
      CF_AIG_TOKEN: "tok-test",
      AI: { gateway: () => ({ getUrl: async () => "https://gateway.example/v1" }) },
    } as unknown as Parameters<typeof callOpus>[0];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `messages.0.content: "${S.prompt}" is not valid` } }),
          { status: 400 },
        ),
    ) as unknown as typeof fetch;
    let message = "";
    try {
      message = await messageFrom(() => callOpus(env, [{ role: "user", content: S.prompt }]));
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(message, "the call did not throw at all").not.toBe("");
    // POSITIVE: status survives, so an operator can still tell a 400 from a 529.
    expect(message).toContain("400");
    expect(message, "the raw Anthropic error body quotes the request back").not.toContain(S.prompt);
    expectNoSentinels();
  });
});

describe("the labels themselves", () => {
  it("keyLabel keeps the structural prefix and drops everything user-derived", () => {
    const key = `renders/${S.project}/clips/shot-1.mp4`;
    const label = keyLabel(key);
    expect(label.startsWith("renders/#")).toBe(true);
    expect(label).not.toContain(S.project);
    // Stable, so two lines about the same object still join.
    expect(keyLabel(key)).toBe(label);
    // ...and distinct, so two objects do not collapse into one line.
    expect(keyLabel(`renders/${S.project}/clips/shot-2.mp4`)).not.toBe(label);
  });

  it("keyLabel handles a key with no prefix without leaking it", () => {
    expect(keyLabel(S.key)).toBe(`#${shortId(S.key)}`);
    expect(keyLabel(S.key)).not.toContain(S.key);
  });

  it("untrustedLabel drops the value of a field an uploaded document controls", () => {
    const label = untrustedLabel(S.voice);
    expect(label).not.toContain(S.voice);
    expect(label).toContain(`${S.voice.length} chars`);
  });
});
