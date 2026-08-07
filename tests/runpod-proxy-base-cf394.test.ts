/// <reference types="node" />
// cf#394 item 1: the module-side leg of the plane-side RunPod proxy (cp#288).
//
// THE EVIDENCE STANDARD THIS FILE IS BUILT TO. On a DEFAULT value an honoured request and a
// silently substituted one are byte-identical, so a probe that sets RUNPOD_PROXY_BASE to
// "https://api.runpod.ai/v2" could not fail whatever the code did. Every behavioural assertion here
// therefore drives a NON-DEFAULT base -- a host that appears nowhere in the source tree -- so the
// URL the module actually built is distinguishable from the one it would have built anyway.
//
// The suite has four parts and they answer different questions:
//   1. the helper's own logic, pure;
//   2. BEHAVIOUR through the real shipped call sites of both module shapes, with the direct route
//      as the control (that control IS the "no-op for the operator panel" proof);
//   3. the refusal path, asserting ZERO fetches -- a proxied module must never reach RunPod
//      directly, so "it failed over" and "it refused" must not be the same observation;
//   4. a DENOMINATOR guard over the source, so a fifteenth RunPod module cannot be added without
//      either using the helper or turning this red.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import {
  RUNPOD_DIRECT_BASE,
  RUNPOD_MODULE_HEADER,
  resolveRunpodRoute,
  runpodEndpointUrl,
  runpodHeaders,
  runpodCredentialProblem,
  runpodCredentialName,
} from "../modules/_shared/runpod-route";
import ownGpu from "../modules/own-gpu/src/index";
import alibabaWan from "../modules/alibaba-wan/src/index";

/** A base that exists nowhere in this repo, so a URL built from it cannot be a coincidence. */
const PROBE_BASE = "https://proxy-probe.cf394.invalid/api/runpod/v2";
const PROBE_HOST = "proxy-probe.cf394.invalid";
const PROBE_TOKEN = "vjp1.ten_cf394probe.deadbeefcafe";
/** Distinct from the token, so "which credential went on the wire" is answerable, not inferred. */
const DIRECT_KEY = "rpa_direct_key_cf394";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function recorder(respond: (url: string) => Response) {
  const calls: Recorded[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const h = (init?.headers ?? {}) as Record<string, string>;
    for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    calls.push({ url, method: init?.method ?? "GET", headers });
    return respond(url);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function jobResponse(): Response {
  return new Response(JSON.stringify({ id: "job-cf394", status: "IN_QUEUE" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Exact hostname, never substring: "api.runpod.ai" appears inside evil-api.runpod.ai.example. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function invoke(worker: { fetch(r: Request, e: never): Promise<Response> }, env: unknown, body: unknown) {
  return worker.fetch(
    new Request("https://module.example/invoke", { method: "POST", body: JSON.stringify(body) }),
    env as never,
  );
}

const MOTION_BODY = {
  hook: "motion.backend",
  input: { shot_id: "shot_01", prompt: "a probe", keyframe_url: "https://example.invalid/kf.png" },
  config: {},
  context: { project: "cf394" },
};

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ------------------------------------------------------------------------------------------- 1.
describe("resolveRunpodRoute: the branch is BOUND-ness, never failover", () => {
  it("unbound -> direct route carrying the RunPod key", () => {
    const r = resolveRunpodRoute(undefined, "", DIRECT_KEY);
    expect(r.proxied).toBe(false);
    expect(r.base).toBe(RUNPOD_DIRECT_BASE);
    expect(r.credential).toBe(DIRECT_KEY);
  });

  it("bound -> proxied route carrying the PLANE token, and the RunPod key is not reachable", () => {
    const r = resolveRunpodRoute(PROBE_BASE, PROBE_TOKEN, DIRECT_KEY);
    expect(r.proxied).toBe(true);
    expect(r.base).toBe(PROBE_BASE);
    expect(r.credential).toBe(PROBE_TOKEN);
    expect(r.credential).not.toBe(DIRECT_KEY);
  });

  it("stays proxied with an EMPTY token -- a missing credential is a refusal, not a fallback", () => {
    const r = resolveRunpodRoute(PROBE_BASE, "", DIRECT_KEY);
    expect(r.proxied).toBe(true);
    expect(r.credential).toBe("");
    // The load-bearing one. If this ever became DIRECT_KEY, a shared tenant would reach RunPod
    // with a RunPod credential, which is the invariant the whole proxy exists to satisfy.
    expect(r.base).not.toBe(RUNPOD_DIRECT_BASE);
  });

  it("treats blank/whitespace as UNBOUND and strips trailing slashes", () => {
    expect(resolveRunpodRoute("", "t", DIRECT_KEY).proxied).toBe(false);
    expect(resolveRunpodRoute("   ", "t", DIRECT_KEY).proxied).toBe(false);
    expect(resolveRunpodRoute(PROBE_BASE + "///", "t", DIRECT_KEY).base).toBe(PROBE_BASE);
  });

  it("builds RunPod's own suffix shape on both routes", () => {
    const direct = resolveRunpodRoute(undefined, "", DIRECT_KEY);
    const proxied = resolveRunpodRoute(PROBE_BASE, PROBE_TOKEN, DIRECT_KEY);
    expect(runpodEndpointUrl(direct, "ep1") + "/run").toBe("https://api.runpod.ai/v2/ep1/run");
    expect(runpodEndpointUrl(proxied, "ep1") + "/status/j").toBe(PROBE_BASE + "/ep1/status/j");
  });

  it("sends the attribution header only on the proxied route", () => {
    const proxied = resolveRunpodRoute(PROBE_BASE, PROBE_TOKEN, DIRECT_KEY);
    const direct = resolveRunpodRoute(undefined, "", DIRECT_KEY);
    expect(runpodHeaders(proxied, "own-gpu")[RUNPOD_MODULE_HEADER]).toBe("own-gpu");
    expect(runpodHeaders(proxied, "own-gpu").authorization).toBe("Bearer " + PROBE_TOKEN);
    expect(runpodHeaders(direct, "own-gpu")[RUNPOD_MODULE_HEADER]).toBeUndefined();
    expect(runpodHeaders(direct, "own-gpu").authorization).toBe("Bearer " + DIRECT_KEY);
  });

  it("names the binding that is actually missing, per route (the cf#114 distinction)", () => {
    const proxied = resolveRunpodRoute(PROBE_BASE, "", DIRECT_KEY);
    const direct = resolveRunpodRoute(undefined, "", "");
    expect(runpodCredentialName(proxied)).toBe("RUNPOD_PROXY_TOKEN");
    expect(runpodCredentialName(direct)).toBe("RUNPOD_API_KEY");
    // endpoint present + credential absent stays PROPAGATION on both routes, never "misconfigured"
    expect(runpodCredentialProblem(proxied, true)).toMatch(/retry shortly/);
    expect(runpodCredentialProblem(direct, true)).toMatch(/retry shortly/);
    // both absent is a genuine misconfiguration, and it must name the right binding
    expect(runpodCredentialProblem(proxied, false)).toContain("RUNPOD_PROXY_TOKEN");
    expect(runpodCredentialProblem(proxied, false)).not.toContain("RUNPOD_API_KEY");
    expect(runpodCredentialProblem(direct, false)).toContain("RUNPOD_API_KEY");
    expect(runpodCredentialProblem(resolveRunpodRoute(PROBE_BASE, PROBE_TOKEN, ""), true)).toBeNull();
  });

  it("names ONLY what is absent: a healthy credential is never reported as unconfigured", () => {
    // The fourth state. Credential present, endpoint absent -- so the endpoint is the finding and
    // the credential must not be mentioned at all. Asserted on BOTH routes, because the direct one
    // had the same defect before the proxy existed and a fix on one route only would leave the
    // other lying in exactly the same way.
    const proxied = resolveRunpodRoute(PROBE_BASE, PROBE_TOKEN, "");
    const direct = resolveRunpodRoute(undefined, "", DIRECT_KEY);
    for (const [label, route] of [["proxied", proxied], ["direct", direct]] as const) {
      const msg = runpodCredentialProblem(route, false);
      expect(msg, label).toContain("RUNPOD_ENDPOINT_ID");
      expect(msg, `${label}: named a credential that is present`).not.toContain("RUNPOD_PROXY_TOKEN");
      expect(msg, `${label}: named a credential that is present`).not.toContain("RUNPOD_API_KEY");
    }
    // CONTROL: with the credential ALSO absent the message must name it again, or the assertions
    // above are satisfiable by a function that never names a credential in any state.
    expect(runpodCredentialProblem(resolveRunpodRoute(PROBE_BASE, "", ""), false)).toContain("RUNPOD_PROXY_TOKEN");
    expect(runpodCredentialProblem(resolveRunpodRoute(undefined, "", ""), false)).toContain("RUNPOD_API_KEY");
  });
});

// ------------------------------------------------------------------------------------------- 2.
describe("own-gpu (env-driven endpoint shape) honours a NON-DEFAULT proxy base", () => {
  it("submits to the probe host with the plane token, never to RunPod", async () => {
    const { fn, calls } = recorder(() => jobResponse());
    globalThis.fetch = fn;
    const res = await invoke(ownGpu, {
      RUNPOD_API_KEY: DIRECT_KEY,
      RUNPOD_ENDPOINT_ID: "ep-own",
      RUNPOD_PROXY_BASE: PROBE_BASE,
      RUNPOD_PROXY_TOKEN: PROBE_TOKEN,
    }, MOTION_BODY);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.error ?? "").toBe("");
    expect(body.ok).toBe(true);

    expect(calls.length).toBeGreaterThan(0);
    const submit = calls.find((c) => c.url.endsWith("/run"));
    expect(submit, "own-gpu issued no /run").toBeDefined();
    expect(submit!.url).toBe(PROBE_BASE + "/ep-own/run");
    expect(hostOf(submit!.url)).toBe(PROBE_HOST);
    expect(submit!.headers.authorization).toBe("Bearer " + PROBE_TOKEN);
    expect(submit!.headers[RUNPOD_MODULE_HEADER]).toBe("own-gpu");
    // Nothing at all reached RunPod, and the RunPod key never went on any wire.
    expect(calls.some((c) => hostOf(c.url) === "api.runpod.ai")).toBe(false);
    expect(calls.some((c) => hostOf(c.url) === "rest.runpod.io")).toBe(false);
    expect(JSON.stringify(calls)).not.toContain(DIRECT_KEY);
  });

  it("CONTROL: unbound base is byte-for-byte the pre-change direct path", async () => {
    const { fn, calls } = recorder(() => jobResponse());
    globalThis.fetch = fn;
    const res = await invoke(ownGpu, {
      RUNPOD_API_KEY: DIRECT_KEY,
      RUNPOD_ENDPOINT_ID: "ep-own",
    }, MOTION_BODY);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const submit = calls.find((c) => c.url.endsWith("/run"))!;
    expect(submit.url).toBe("https://api.runpod.ai/v2/ep-own/run");
    expect(hostOf(submit.url)).toBe("api.runpod.ai");
    expect(submit.headers.authorization).toBe("Bearer " + DIRECT_KEY);
    expect(submit.headers[RUNPOD_MODULE_HEADER]).toBeUndefined();
  });

  it("does NOT attempt the rest.runpod.io workersMax reconcile on the proxied route", async () => {
    const { fn, calls } = recorder(() => jobResponse());
    globalThis.fetch = fn;
    // RUNPOD_WORKERS_MAX is what triggers reconcileRunpodEndpointWorkersMax, which targets the
    // RunPod MANAGEMENT API (rest.runpod.io/v1) -- a host the plane proxy does not carry and an
    // operator-scoped action a tenant must not perform. Unhandled, this fails EVERY proxied submit.
    const res = await invoke(ownGpu, {
      RUNPOD_API_KEY: DIRECT_KEY,
      RUNPOD_ENDPOINT_ID: "ep-own",
      RUNPOD_WORKERS_MAX: "3",
      RUNPOD_PROXY_BASE: PROBE_BASE,
      RUNPOD_PROXY_TOKEN: PROBE_TOKEN,
    }, MOTION_BODY);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.error ?? "").toBe("");
    expect(body.ok).toBe(true);
    expect(calls.some((c) => hostOf(c.url) === "rest.runpod.io")).toBe(false);
  });
});

describe("alibaba-wan (public-slug shape) honours a NON-DEFAULT proxy base", () => {
  it("keeps the slug as the endpoint segment under the probe base", async () => {
    const { fn, calls } = recorder(() => jobResponse());
    globalThis.fetch = fn;
    const res = await invoke(alibabaWan, {
      RUNPOD_API_KEY: DIRECT_KEY,
      RUNPOD_PROXY_BASE: PROBE_BASE,
      RUNPOD_PROXY_TOKEN: PROBE_TOKEN,
      R2_RENDERS: { put: async () => undefined },
    }, MOTION_BODY);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.error ?? "").toBe("");
    expect(body.ok).toBe(true);
    const submit = calls.find((c) => c.url.endsWith("/run"))!;
    // The slug is preserved exactly -- it is what the plane's PUBLIC_ENDPOINT_ALLOWLIST matches on.
    expect(submit.url).toBe(PROBE_BASE + "/wan-2-6-i2v/run");
    expect(hostOf(submit.url)).toBe(PROBE_HOST);
    expect(submit.headers.authorization).toBe("Bearer " + PROBE_TOKEN);
    expect(submit.headers[RUNPOD_MODULE_HEADER]).toBe("alibaba-wan");
    expect(calls.some((c) => hostOf(c.url) === "api.runpod.ai")).toBe(false);
  });

  it("CONTROL: unbound base is byte-for-byte the pre-change direct path", async () => {
    const { fn, calls } = recorder(() => jobResponse());
    globalThis.fetch = fn;
    const res = await invoke(alibabaWan, {
      RUNPOD_API_KEY: DIRECT_KEY,
      R2_RENDERS: { put: async () => undefined },
    }, MOTION_BODY);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const submit = calls.find((c) => c.url.endsWith("/run"))!;
    expect(submit.url).toBe("https://api.runpod.ai/v2/wan-2-6-i2v/run");
    expect(submit.headers.authorization).toBe("Bearer " + DIRECT_KEY);
  });
});

// ------------------------------------------------------------------------------------------- 3.
describe("a proxied module with no token REFUSES; it never reaches RunPod instead", () => {
  it("own-gpu names RUNPOD_PROXY_TOKEN and issues ZERO fetches", async () => {
    const { fn, calls } = recorder(() => jobResponse());
    globalThis.fetch = fn;
    const res = await invoke(ownGpu, {
      // The RunPod key IS present, which is the whole point: the module must not use it.
      RUNPOD_API_KEY: DIRECT_KEY,
      RUNPOD_ENDPOINT_ID: "ep-own",
      RUNPOD_PROXY_BASE: PROBE_BASE,
      RUNPOD_PROXY_TOKEN: "",
    }, MOTION_BODY);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    // endpoint present + credential absent = propagation, not misconfiguration (cf#114)
    expect(body.error).toMatch(/retry shortly/);
    expect(body.error).not.toContain("RUNPOD_API_KEY");
    expect(calls.length).toBe(0);
  });

  it("alibaba-wan names RUNPOD_PROXY_TOKEN rather than RUNPOD_API_KEY", async () => {
    const { fn, calls } = recorder(() => jobResponse());
    globalThis.fetch = fn;
    const res = await invoke(alibabaWan, {
      RUNPOD_API_KEY: DIRECT_KEY,
      RUNPOD_PROXY_BASE: PROBE_BASE,
      RUNPOD_PROXY_TOKEN: "",
      R2_RENDERS: { put: async () => undefined },
    }, MOTION_BODY);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("RUNPOD_PROXY_TOKEN");
    expect(body.error).not.toContain("RUNPOD_API_KEY");
    expect(calls.length).toBe(0);
  });
});

// ------------------------------------------------------------------------------ 3b. FAIL FIRST
describe("the call genuinely TRANSITS the base: one stub, two configs, opposite outcomes", () => {
  // NOTHING BINDS RUNPOD_PROXY_BASE ANYWHERE TODAY (measured plane-side: it appears in the control
  // plane's src only inside comments, and 0 files under vivijure-cf/modules matched it against a
  // 42-hit RUNPOD_API_KEY positive control). That is what makes this block necessary rather than
  // thorough: a module that ALWAYS takes the fallback is byte-identical to a module nobody touched,
  // so it compiles, deploys, and passes every other test in this file -- because the fallback IS the
  // current behaviour. A green no-op would ship and nobody would learn otherwise until a hosted
  // render was expected to transit the proxy and quietly did not.
  //
  // So the probe base here CANNOT ANSWER, and RunPod can. The two configurations then have opposite
  // outcomes, and no wrong implementation produces both: a module ignoring the binding succeeds in
  // both cases (it never touches the refusing host), and a module that always proxies fails in both.

  /** Refuses anything aimed at the probe host, answers RunPod normally. The refusal is a THROW,
   *  which is what an unresolvable or unreachable base does at the fetch layer. */
  function stubThatCannotAnswerTheProbe() {
    const calls: string[] = [];
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (hostOf(url) === PROBE_HOST) throw new TypeError("fetch failed: " + PROBE_HOST + " cannot answer");
      return jobResponse();
    });
    return { fn: fn as unknown as typeof fetch, calls };
  }

  const CASES: Array<{ name: string; worker: { fetch(r: Request, e: never): Promise<Response> }; extra: Record<string, unknown> }> = [
    { name: "own-gpu", worker: ownGpu, extra: { RUNPOD_ENDPOINT_ID: "ep-own" } },
    { name: "alibaba-wan", worker: alibabaWan, extra: { R2_RENDERS: { put: async () => undefined } } },
  ];

  for (const c of CASES) {
    it(`${c.name}: PROXIED -> the unanswerable base is reached and the submit FAILS there`, async () => {
      const { fn, calls } = stubThatCannotAnswerTheProbe();
      globalThis.fetch = fn;
      const res = await invoke(c.worker, {
        RUNPOD_API_KEY: DIRECT_KEY,
        RUNPOD_PROXY_BASE: PROBE_BASE,
        RUNPOD_PROXY_TOKEN: PROBE_TOKEN,
        ...c.extra,
      }, MOTION_BODY);
      const body = (await res.json()) as { ok: boolean; error?: string };

      // THE LOAD-BEARING PAIR. The module must have gone to the probe host, and the refusal there
      // must be what it reports. Either half alone is satisfiable by an implementation that is wrong.
      expect(calls.some((u) => hostOf(u) === PROBE_HOST), `no call reached ${PROBE_HOST}: ${calls.join(", ")}`).toBe(true);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("cannot answer");

      // AND IT MUST NOT HAVE RECOVERED. RunPod was answering the whole time; a module that fell
      // back would be sitting on ok:true right now, holding a RunPod credential on a shared tenant.
      expect(calls.some((u) => hostOf(u) === "api.runpod.ai"), "fell back to RunPod after the plane refused").toBe(false);
    });

    it(`${c.name}: UNBOUND -> the SAME stub yields success, because RunPod answered`, async () => {
      const { fn, calls } = stubThatCannotAnswerTheProbe();
      globalThis.fetch = fn;
      const res = await invoke(c.worker, { RUNPOD_API_KEY: DIRECT_KEY, ...c.extra }, MOTION_BODY);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.error ?? "").toBe("");
      expect(body.ok).toBe(true);
      expect(calls.some((u) => hostOf(u) === "api.runpod.ai")).toBe(true);
      expect(calls.some((u) => hostOf(u) === PROBE_HOST)).toBe(false);
    });
  }
});

// ------------------------------------------------------------------------------------------- 4.
describe("DENOMINATOR: every RunPod-reaching module routes through the shared helper", () => {
  const MODULES_DIR = "modules";
  // WHERE THE DIRECT BASE LITERAL NOW LIVES (cp#321 step 2). It used to be declared in
  // modules/_shared/runpod-route.ts; that file is now a re-export of vivijure-core and declares
  // nothing, so the positive control below follows the literal to core's SHIPPED artifact rather
  // than to the pointer that replaced it.
  //
  // This control going red on the move is the control working: it is anchored to a file that must
  // carry the literal, and the moment that stopped being true it said so instead of passing
  // vacuously. Re-pointing it at the installed package keeps that property AND adds one: it now
  // also proves the dependency actually ships the base, so a bad publish cannot read as a clean
  // sweep either.
  const HELPER = "node_modules/@skyphusion-labs/vivijure-core/dist/runpod-route.js";

  /**
   * One module's source, as CODE.
   *
   * Two deliberate mechanics, both of which this file got wrong on the first pass:
   *
   *  - WHOLE-LINE comments only. A general `//` strip destroys every `https://` inside a string
   *    literal, which is exactly the text being asserted about. Whole-line is the idiom
   *    module-host-gate.test.ts already uses here and it cannot eat a URL that sits in code.
   *  - STRIP FIRST, FLATTEN SECOND. Flattening removes the newlines a line-scoped comment stripper
   *    needs, so doing it the other way round silently swallows the rest of the file from the first
   *    comment onward -- and the resulting empty string passes every absence assertion below.
   *
   * Flattening is kept because the census it reconciles against is statement-level: narration-gen
   * builds its endpoint as `"https://api.runpod.ai/v2/" + MODEL`, and a matcher that cannot see
   * across a statement returns a smaller, confident, wrong number.
   */
  function moduleCode(m: string): string {
    const dir = `${MODULES_DIR}/${m}/src`;
    if (!existsSync(dir)) return "";
    return readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(`${dir}/${f}`, "utf8"))
      .join("\n")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n")
      .replace(/\s+/g, " ");
  }

  const modules = readdirSync(MODULES_DIR).filter((m) => existsSync(`${MODULES_DIR}/${m}/src/index.ts`));
  const runpodModules = modules.filter((m) => /api\.runpod\.ai\/v2/.test(moduleCode(m)) || /_shared\/runpod-route/.test(moduleCode(m)));

  it("POSITIVE CONTROL: the matcher finds the literal in the one file that must still carry it", () => {
    // Without this, a renamed helper or a moved file makes every absence assertion below pass
    // vacuously -- a matcher anchored to a path that no longer exists rejects everything perfectly.
    const helper = readFileSync(HELPER, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    expect(/https:\/\/api\.runpod\.ai\/v2/.test(helper)).toBe(true);
  });

  it("POSITIVE-EVIDENCE FLOOR: the census is not empty (a broken matcher reads as a clean sweep)", () => {
    // Measured 2026-08-03 at vivijure-cf@83ea481: 26 modules carry src/index.ts and 14 of them
    // reach RunPod (8 hard-coding a public model slug, 6 reading RUNPOD_ENDPOINT_ID). Asserted as a
    // FLOOR rather than as equality: a new non-RunPod module is normal and must not turn this red,
    // while a matcher that has stopped matching must.
    expect(modules.length).toBeGreaterThanOrEqual(26);
    expect(runpodModules.length).toBeGreaterThanOrEqual(14);
  });

  it("every RunPod-reaching module imports the shared route helper", () => {
    const missing = runpodModules.filter((m) => !/_shared\/runpod-route/.test(moduleCode(m)));
    expect(missing, `reach RunPod without the shared route helper: ${missing.join(", ")}`).toEqual([]);
  });

  it("no module hard-codes the RunPod base -- the helper is the only place it lives", () => {
    // This is what makes the swap complete rather than partial. A module keeping its own
    // `https://api.runpod.ai/v2` literal would ignore RUNPOD_PROXY_BASE at that one call site and
    // reach RunPod directly from a shared tenant, which no test of the proxied path would notice.
    const offenders = modules.filter((m) => /https:\/\/api\.runpod\.ai\/v2/.test(moduleCode(m)));
    expect(offenders, `still building the RunPod base themselves: ${offenders.join(", ")}`).toEqual([]);
  });
});
