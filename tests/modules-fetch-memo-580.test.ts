/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

import {
  cached,
  load,
  registryFailureReason,
  registryUnavailable,
  reset,
  setTransport,
} from "../public/module-registry.js";

// cf#580 -- ONE GET /api/modules per page load, and an instrument that can actually see the
// population it counts.
//
// THE ISSUE AS FILED WAS WRONG, and the way it was wrong is the point of this file. cf#580 says six
// call sites, three un-memoised. The measured population at the parent commit was SEVEN call sites,
// ONE memoised. The two extra were not new and they were not hiding: they were INVISIBLE TO THE
// MATCHER the previous suite used, /fetch\("\/api\/modules"\)/, which demands a closing paren
// immediately after the URL string and a lowercase f.
//
//   readonly-gate.js:33   origFetch("/api/modules")                  -- callee is not "fetch"
//   settings.js:347       fetch("/api/modules", { headers: ... })    -- a second argument
//
// A regex that matches only the shape it already knows can never reveal blindness to a different
// shape of the same call. Its zero is a statement about the regex. So the population here is derived
// by a UNION of independent matchers, over a file list read off the FILESYSTEM rather than a literal
// array, with a positive control per shape and a proof that the old matcher is blind to two of them.
// The previous suite asserted expect(plannerOwn.length).toBe(2) over its own hardcoded array, which
// proves the array has two entries and nothing whatever about the tree.

const PUBLIC = process.cwd() + "/public";
const readPublic = (name: string) => readFileSync(PUBLIC + "/" + name, "utf8");
const codeLines = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// Every panel script, DERIVED. A file added next year is in the population automatically; that is
// the whole difference between this and a literal list.
const JS_FILES = readdirSync(PUBLIC).filter((f) => f.endsWith(".js")).sort();
const HTML_FILES = readdirSync(PUBLIC).filter((f) => f.endsWith(".html")).sort();

// --- the matchers ----------------------------------------------------------------------------
//
// OLD is kept deliberately, not as a check but as the CONTROL that shows what the previous
// denominator was measuring.
const OLD = () => /fetch\("\/api\/modules"\)/g;
// CALLEE: any identifier callee (fetch, origFetch, boundFetch, ...) with any argument list.
const CALLEE = () => /[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*"\/api\/modules"\s*[,)]/g;
// LITERAL: callee-agnostic. Catches an indirect callee such as transport()("/api/modules"), which
// CALLEE cannot see because there is no identifier immediately before the paren. Negative lookahead
// on a slash so the per-module config route, "/api/modules/" + name + "/config", is NOT counted.
const LITERAL = () => /"\/api\/modules"(?!\/)/g;

const hits = (re: RegExp, src: string) => src.match(re)?.length ?? 0;
// The population: union of CALLEE and LITERAL, never intersection. An intersection would silently
// drop exactly the shapes the union exists to catch.
const isFetcher = (src: string) => hits(CALLEE(), src) > 0 || hits(LITERAL(), src) > 0;

const PLANTS: [string, string][] = [
  ["bare call", "fetch(\"/api/modules\")"],
  ["non-lowercase callee", "var ready = origFetch(\"/api/modules\")"],
  ["second argument", "fetch(\"/api/modules\", { headers: { accept: \"application/json\" } })"],
  ["awaited assignment", "const res = await fetch(\"/api/modules\");"],
  ["indirect callee", "loadPromise = transport()(\"/api/modules\")"],
];

describe("cf#580 the INSTRUMENT: the matcher can see every shape of the call", () => {
  it.each(PLANTS)("POSITIVE CONTROL -- the union finds a planted %s", (_shape, planted) => {
    // Planted into a source known to contain none, so a hit can only be the plant. Without this the
    // empty results below are statements about the regex rather than about the tree.
    const clean = codeLines(readPublic("topbar.js"));
    expect(isFetcher(clean), "topbar.js must be clean for this control to mean anything").toBe(false);
    expect(isFetcher(clean + "\n" + planted)).toBe(true);
  });

  it("THE OLD MATCHER IS BLIND to two of those five shapes, which is why the issue undercounted", () => {
    const blind = PLANTS.filter(([, planted]) => hits(OLD(), planted) === 0).map(([shape]) => shape);
    // A control returning zero proves nothing on its own, so the same matcher is shown FINDING the
    // shape it does know before it is trusted to have missed the others.
    expect(hits(OLD(), "fetch(\"/api/modules\")")).toBe(1);
    // THREE of five, measured rather than assumed: the awaited assignment still CONTAINS the exact
    // substring the old matcher looks for, so it was never the blind spot. The blind spots are the
    // ones that change the CALLEE or the ARGUMENT LIST, which is precisely why the two real sites it
    // missed were readonly-gate.js (origFetch) and settings.js (a second argument).
    expect(blind.sort()).toEqual(
      ["indirect callee", "non-lowercase callee", "second argument"].sort(),
    );
  });

  it("NEGATIVE CONTROL -- the per-module config route is a different route and is not counted", () => {
    // settings.js reads and writes GET/PATCH /api/modules/:name/config. Counting those would inflate
    // the denominator with calls this change neither touches nor should.
    const config = "fetch(\"/api/modules/\" + encodeURIComponent(name) + \"/config\", { method: \"PATCH\" })";
    expect(isFetcher(config)).toBe(false);
    // And the real file still makes those calls, so the exclusion is load-bearing rather than moot.
    expect(readPublic("settings.js")).toContain("/api/modules/");
  });
});

describe("cf#580 the POPULATION: exactly one script under public/ fetches the projection", () => {
  it("derives the fetcher set from the filesystem and finds ONLY module-registry.js", () => {
    const fetchers = JS_FILES.filter((f) => isFetcher(codeLines(readPublic(f))));
    // eslint-disable-next-line no-console
    console.log(`cf#580 population: ${fetchers.length} of ${JS_FILES.length} public/*.js fetch /api/modules -> ${fetchers.join(", ")}`);
    // Denominator asserted: a JS_FILES that came back empty would otherwise pass this silently.
    expect(JS_FILES.length, "no public/*.js found; the harness is pointed at the wrong tree").toBeGreaterThan(20);
    expect(fetchers).toEqual(["module-registry.js"]);
  });

  it("the six rewired callers each read the memo and hold no fetch of their own", () => {
    const REWIRED = [
      "abuse-link.js",
      "app.js",
      "demo-steer.js",
      "hook-availability.js",
      "readonly-gate.js",
      "settings.js",
    ];
    for (const f of REWIRED) {
      const code = codeLines(readPublic(f));
      expect(isFetcher(code), f + " still fetches /api/modules directly").toBe(false);
      expect(code, f + " does not read the shared memo").toContain("moduleRegistry.load()");
    }
    expect(REWIRED.length).toBe(6);
  });

  it("planner-registry.js DELEGATES rather than keeping a second memo on the same page", () => {
    // Two memos on one page is this defect relocated, not fixed: planner.html would make two
    // requests, one for the chrome and one for the planner controls.
    const code = codeLines(readPublic("planner-registry.js"));
    expect(isFetcher(code)).toBe(false);
    expect(code, "planner-registry.js still owns an in-flight promise of its own").not.toContain("loadPromise");
    expect(code, "planner-registry.js does not delegate").toContain(".load()");
    // And it REFUSES rather than falling back to its own fetch when the shared file is missing. A
    // silent fallback there would rebuild the second memo and read as working.
    expect(code).toContain("module-registry.js is not loaded");
  });
});

describe("cf#580 the PER-PAGE claim, made against what a page actually loads", () => {
  // Asserting over a file in isolation says nothing about a page. These counts come from the script
  // tags, which is the only thing that decides how many requests a load makes.
  const scriptsOf = (html: string) =>
    Array.from(readPublic(html).matchAll(/<script[^>]*\ssrc="([^"]+)"/g)).map((m) => m[1]);

  const BEFORE: Record<string, number> = {
    "planner.html": 5,
    "modules.html": 5,
    "cast.html": 3,
    "settings.html": 3,
  };

  it("every studio page now makes exactly ONE GET /api/modules per load", () => {
    expect(HTML_FILES.sort()).toEqual(Object.keys(BEFORE).sort());
    for (const page of HTML_FILES) {
      const scripts = scriptsOf(page);
      const fetchers = scripts.filter((s) => JS_FILES.includes(s) && isFetcher(codeLines(readPublic(s))));
      // eslint-disable-next-line no-console
      console.log(`cf#580 ${page}: ${fetchers.length} of ${scripts.length} loaded scripts fetch /api/modules (was ${BEFORE[page]})`);
      expect(scripts.length, page + " parsed to zero scripts; the tag matcher is broken").toBeGreaterThan(5);
      expect(fetchers, page + " must fetch the projection exactly once").toEqual(["module-registry.js"]);
    }
  });

  it("loads module-registry.js AFTER auth-token.js and BEFORE readonly-gate.js on every page", () => {
    // Not cosmetic ordering. module-registry.js binds window.fetch at eval, so this window is what
    // decides that the bound transport carries the auth header and is NOT the read-only wrapper.
    for (const page of HTML_FILES) {
      const scripts = scriptsOf(page);
      const at = (name: string) => scripts.indexOf(name);
      expect(at("auth-token.js"), page + " does not load auth-token.js").toBeGreaterThan(-1);
      expect(at("readonly-gate.js"), page + " does not load readonly-gate.js").toBeGreaterThan(-1);
      expect(at("module-registry.js"), page).toBeGreaterThan(at("auth-token.js"));
      expect(at("module-registry.js"), page).toBeLessThan(at("readonly-gate.js"));
    }
  });
});

// --- behaviour -------------------------------------------------------------------------------

type Resp = { ok: boolean; status?: number; json: () => Promise<unknown> };
const PAYLOAD = { modules: [{ name: "own-gpu" }], hooks: {}, catalog: [], host: { readonly: true } };
const EMPTY = { modules: [], hooks: {}, catalog: [] };

describe("cf#580 the MEMO CONTRACT, preserved from planner-registry.js", () => {
  beforeEach(() => reset());

  it("N concurrent callers before resolution share ONE in-flight request", async () => {
    let calls = 0;
    let release: (r: Resp) => void = () => {};
    setTransport(() => {
      calls += 1;
      return new Promise<Resp>((res) => {
        release = res;
      });
    });
    const waiters = [load(), load(), load(), load(), load()];
    release({ ok: true, json: () => Promise.resolve(PAYLOAD) });
    const all = await Promise.all(waiters);
    // eslint-disable-next-line no-console
    console.log(`cf#580 one-flight: ${calls} request for ${waiters.length} concurrent callers`);
    expect(calls).toBe(1);
    for (const r of all) expect(r).toEqual(PAYLOAD);
  });

  it("a resolved cache short-circuits with NO further request", async () => {
    let calls = 0;
    setTransport(() => {
      calls += 1;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(PAYLOAD) });
    });
    await load();
    await load();
    await load();
    expect(calls).toBe(1);
    expect(cached()).toEqual(PAYLOAD);
  });

  it.each([
    ["a non-ok response", () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null) }), true, "/api/modules -> 503"],
    ["a transport throw", () => Promise.reject(new Error("network down")), true, "network down"],
    ["an EMPTY but successful projection", () => Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY) }), false, ""],
    ["a populated projection", () => Promise.resolve({ ok: true, json: () => Promise.resolve(PAYLOAD) }), false, ""],
  ])("%s: load() never rejects, and cf#344 stays distinguishable", async (_l, impl, unavailable, reason) => {
    setTransport(impl as () => Promise<Resp>);
    // NEVER REJECTS is the load-bearing half: every read-only caller depends on it to degrade
    // quietly instead of growing its own catch.
    const data = await load();
    expect(data).toBeTruthy();
    expect(registryUnavailable()).toBe(unavailable);
    expect(registryFailureReason()).toBe(reason);
  });

  it("an unreachable registry and an empty one produce the SAME payload, which is why the flag exists", async () => {
    setTransport(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null) }));
    const failed = await load();
    reset();
    setTransport(() => Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY) }));
    const empty = await load();
    expect(failed).toEqual(empty);
  });

  it("registryUnavailable() is false BEFORE any load, so it cannot be read early by accident", () => {
    setTransport(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null) }));
    expect(registryUnavailable()).toBe(false);
    expect(registryFailureReason()).toBe("");
  });

  it("REFUSES to invent a transport rather than silently issuing an un-memoised request", () => {
    // The eval hazard, asserted. Several suites eval panel scripts in plain Node where window does
    // not exist but a global fetch does. A silent fallback there would run, look like it worked, and
    // re-open exactly the fan-out this change closes.
    setTransport(null);
    expect(() => load()).toThrow(/no fetch transport bound/);
  });
});
