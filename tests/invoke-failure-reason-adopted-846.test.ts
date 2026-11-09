// cf#846: first-party modules DECLARE `reason` on the invoke failures whose class they know.
//
// `tests/invoke-failure-reason-vendored.test.ts` proves every contract can carry the field. This
// file proves the modules SET it, over their real HTTP handlers, and that setting it changed no
// retry decision. The consumer is core's `classifyInvokeFailure` (render-orchestrator), which reads
// a declared class before it reads the sentence.
//
// WHAT IS SET, AND WHY ONLY THIS. A class is declared only where the condition that produced the
// failure names it outright:
//   * `bad-input`      invalid JSON body, a missing or malformed input field, an input over a cap
//   * `unsupported`    a hook this module does not serve
//   * `not-configured` an inline `if (!x)` on GATEWAY_ID, the RunPod credential, a backend URL
// All three are `deterministic` in core's INVOKE_FAILURE_DISPOSITION, and so is the prose reading of
// every one of those sentences. So adopting the field moves no retry decision; the last case below
// holds that.
//
// WHAT IS LEFT ABSENT ON PURPOSE. A failure whose class the module does not know stays without
// `reason`, so core keeps its prose road for it. Examples: "submit failed: <e.message>" (the message
// may be "fetch failed", which prose reads as transient; any class here would be a guess and
// `backend-error` would turn a retry into a hard fail), "could not start generation workflow",
// "could not persist run state", and `credentialProblem(...)`, which returns either "not configured"
// or "credential not yet visible on this worker version (retry shortly)", two different conditions
// behind one string. ABSENT means "not adopted at this site", never a default class.
//
// `PollResponse` and `CancelResponse` carry NO `reason`. That is the core#306 decision recorded in
// the vendored test: the poll arm has its own closed `outcome` set, and two closed unions sharing
// `backend-error` and `cancelled` on one object would mean two things under one spelling.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  INVOKE_FAILURE_DISPOSITION,
  INVOKE_FAILURE_REASONS,
  type InvokeFailureReason,
} from "@skyphusion-labs/vivijure-core/modules/types";
import { classifyInvokeFailure, classifyTransientFailure } from "@skyphusion-labs/vivijure-core/render-orchestrator";

const MODULES_DIR = join(import.meta.dirname, "..", "modules");

const MODULES = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "_shared")
  .map((e) => e.name)
  .filter((m) => existsSync(join(MODULES_DIR, m, "src", "index.ts")))
  .sort();

type Worker = { fetch: (req: Request, env: never, ctx: never) => Promise<Response> };
const CTX = { waitUntil() {}, passThroughOnException() {} } as never;

async function load(m: string): Promise<Worker> {
  return ((await import(`../modules/${m}/src/index.ts`)) as { default: Worker }).default;
}

async function post(w: Worker, path: string, body: string): Promise<Record<string, unknown>> {
  const res = await w.fetch(
    new Request("https://module" + path, { method: "POST", headers: { "content-type": "application/json" }, body }),
    {} as never,
    CTX,
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("cf#846: every module declares the class of the invoke failures it can name", () => {
  it("CONTROL: the scan found the module tree", () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(33);
    expect(MODULES).toContain("cf-seedance");
    expect(MODULES).toContain("notify-email");
  });

  it.each(MODULES)("%s: an invalid JSON /invoke body is bad-input", async (m) => {
    const r = await post(await load(m), "/invoke", "{not json");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad-input");
  });

  it.each(MODULES)("%s: a hook it does not serve is unsupported", async (m) => {
    const r = await post(await load(m), "/invoke", JSON.stringify({ hook: "no-such-hook-846", input: {}, config: {}, context: {} }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unsupported");
  });

  it.each(MODULES)("%s: a /poll failure carries no reason (core#306: the poll arm uses outcome)", async (m) => {
    const r = await post(await load(m), "/poll", "{not json");
    expect(r.ok).toBe(false);
    expect("reason" in r).toBe(false);
  });
});

describe("cf#846: the condition-specific classes, driven through real handlers", () => {
  const SHOT = { shot_id: "s1", keyframe_url: "https://x/k.png", prompt: "a harbor" };
  const req = (hook: string, input: unknown) => JSON.stringify({ hook, input, config: {}, context: { project: "p", job_id: "j" } });

  it("cf-seedance: a shot missing its keyframe is bad-input", async () => {
    const r = await post(await load("cf-seedance"), "/invoke", req("motion.backend", { shot_id: "s1", prompt: "a" }));
    expect(r).toMatchObject({ ok: false, reason: "bad-input" });
  });

  it("cf-seedance: a complete shot with no GATEWAY_ID is not-configured", async () => {
    const r = await post(await load("cf-seedance"), "/invoke", req("motion.backend", SHOT));
    expect(r).toMatchObject({ ok: false, reason: "not-configured" });
    expect(String(r.error)).toContain("GATEWAY_ID not configured");
  });

  it("alibaba-wan: no RunPod credential is not-configured", async () => {
    const r = await post(await load("alibaba-wan"), "/invoke", req("motion.backend", SHOT));
    expect(r).toMatchObject({ ok: false, reason: "not-configured" });
  });
});

// ---- static gates over every site, so the HTTP cases above are not the only coverage ----

interface Site { file: string; line: number; text: string }

function failureLines(): Site[] {
  const out: Site[] = [];
  for (const m of MODULES) {
    const src = join(MODULES_DIR, m, "src");
    for (const f of readdirSync(src).filter((f) => f.endsWith(".ts") && f !== "contract.ts")) {
      readFileSync(join(src, f), "utf8").split("\n").forEach((text, i) => {
        const t = text.trim();
        if (t.startsWith("//") || t.startsWith("*")) return;
        if (/ok:\s*false\s*,/.test(text)) out.push({ file: `${m}/src/${f}`, line: i + 1, text });
      });
    }
  }
  return out;
}

const SITES = failureLines();
const DECLARED = SITES.map((s) => ({ ...s, reason: /\breason:\s*"([^"]*)"/.exec(s.text)?.[1] }))
  .filter((s): s is Site & { reason: string } => s.reason !== undefined);

describe("cf#846: every declared reason is a member, on the invoke arm only", () => {
  it("DENOMINATOR: the scan sees the declared sites", () => {
    expect(SITES.length).toBeGreaterThan(400);
    expect(DECLARED.length).toBeGreaterThanOrEqual(130);
  });

  it("no declared value is outside the closed set (not_configured, quota, ...)", () => {
    const set = new Set<string>(INVOKE_FAILURE_REASONS);
    expect(DECLARED.filter((s) => !set.has(s.reason)).map((s) => `${s.file}:${s.line} ${s.reason}`)).toEqual([]);
  });

  it("no PollResponse or CancelResponse literal carries a reason", () => {
    const bad = DECLARED.filter((s) => /as (PollResponse|CancelResponse)/.test(s.text));
    expect(bad.map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  it("adopting the field moved no retry decision: prose and class agree on every literal sentence", () => {
    // The sentence is taken up to its first non-literal part. A prefix is enough: every prose rule
    // core applies to these sentences is a substring match, and the dynamic tail is an identifier.
    let checked = 0;
    const disagree: string[] = [];
    for (const s of DECLARED) {
      const lit = /error:\s*(?:"([^"]*)"|`([^`$]*))/.exec(s.text);
      if (!lit) continue;
      const sentence = lit[1] ?? lit[2];
      checked += 1;
      const declared = INVOKE_FAILURE_DISPOSITION[s.reason as InvokeFailureReason];
      if (classifyTransientFailure(sentence) !== declared) disagree.push(`${s.file}:${s.line} ${sentence}`);
      expect(classifyInvokeFailure({ error: sentence, reason: s.reason })).toBe(declared);
    }
    expect(checked).toBeGreaterThanOrEqual(100);
    expect(disagree).toEqual([]);
  });
});
