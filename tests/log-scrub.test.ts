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
import { generateOpenAIImage } from "../src/providers/openai-image";

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

describe("provider errors do not carry provider prose (cf#223, openai-image.ts)", () => {
  it("a moderation refusal that quotes the prompt back does NOT reach the exception message", async () => {
    // This is the real shape of an OpenAI image refusal: the message quotes the user's prompt.
    const body = {
      error: {
        message: `Your request was rejected as a result of our safety system. Your prompt "${S.prompt}" may contain content that is not allowed.`,
        type: "invalid_request_error",
        code: "moderation_blocked",
      },
    };
    const fetchStub = vi.fn(async () => new Response(JSON.stringify(body), { status: 400 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    try {
      await expect(
        generateOpenAIImage("sk-test", "openai/gpt-image-1", S.prompt),
      ).rejects.toThrow(/moderation_blocked/);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The throw is what a caller, a log sink and the Exceptions channel all see. Asserting on the
    // message directly, because this leak does not need a console call to escape.
    let message = "";
    try {
      globalThis.fetch = fetchStub as unknown as typeof fetch;
      await generateOpenAIImage("sk-test", "openai/gpt-image-1", S.prompt);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(message).toContain("400");
    expect(message).toContain("moderation_blocked");
    expect(message, "the provider prose quotes the user prompt back").not.toContain(S.prompt);
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
