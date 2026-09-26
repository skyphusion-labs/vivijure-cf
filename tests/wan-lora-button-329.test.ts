/// <reference types="node" />
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

// #329 / core#174: the /cast Wan LoRA button used to POST /api/cast/:id/train-lora with NO
// body at all. That shared route resolves the model family from HOST CONFIG when the body
// omits model_family, so on a host with no Wan training endpoint the button silently trained
// SDXL and returned 200, while the confirm dialog promised a Wan 2.2 expert job at 35-45
// minutes and a 2-to-4 dollar GPU spend. A live CONSENT defect, not a pending regression.
//
// This suite drives the REAL shipped public/cast.js. It fires DOMContentLoaded, lets the
// shipped wire() register the real click listener, and invokes THAT listener, so it asserts
// what the BUTTON does. A test of a helper the button might or might not call would still
// pass with the old URL left inline in trainWanLora, which is the whole failure mode here.

// The operator-facing text the host returns with the 501. It names a binding, which is
// exactly why it must not be forwarded to a tenant.
const OPERATOR_501 =
  "Wan cast LoRA training is not configured on this host (wire RUNPOD_WAN_TRAIN_ENDPOINT_ID)";
const BINDING = "RUNPOD_WAN_TRAIN_ENDPOINT_ID";
const CAST_ID = 7;
const WAN_URL = "/api/cast/7/train-wan-lora";
const SDXL_URL = "/api/cast/7/train-lora";
const PRODUCT_501 =
  "Wan LoRA training is unavailable here. Ask whoever runs this studio to enable it.";

type Listener = (...a: unknown[]) => unknown;

// Generic element stub: every selector resolves to a stable object, so the shipped wire()
// finds every control it looks for and the listeners it registers stay reachable.
class El {
  tagName = "div";
  value = "";
  textContent = "";
  className = "";
  href = "";
  disabled = false;
  hidden = false;
  open = false;
  checked = false;
  files: unknown[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  listeners: Record<string, Listener[]> = {};
  children: El[] = [];
  options: El[] = [];
  addEventListener(ev: string, fn: Listener) {
    if (!this.listeners[ev]) this.listeners[ev] = [];
    this.listeners[ev].push(fn);
  }
  removeEventListener() {}
  appendChild(c: El) { this.children.push(c); this.options.push(c); return c; }
  removeChild() {}
  remove() {}
  removeAttribute() {}
  setAttribute() {}
  getAttribute() { return null; }
  insertAdjacentHTML() {}
  focus() {}
  click() {}
  querySelector() { return null; }
  querySelectorAll(): El[] { return []; }
  closest() { return null; }
  set innerHTML(_v: string) { this.children = []; this.options = []; }
  get innerHTML() { return ""; }
}

interface Call { url: string; method: string; body: string }

let els: Map<string, El>;
let docListeners: Record<string, Listener[]>;
let fetchCalls: Call[];
let trainStatus: number;
let g: Record<string, unknown>;

function elFor(sel: string): El {
  let e = els.get(sel);
  if (!e) { e = new El(); els.set(sel, e); }
  return e;
}

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// A FRESH PAGE LOAD per test: cast.js keeps module-level state inside its IIFE, so each test
// re-evals the shipped file rather than reaching into the closure to reset it.
beforeEach(() => {
  vi.useFakeTimers();
  els = new Map();
  docListeners = {};
  fetchCalls = [];
  trainStatus = 200;
  g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    confirm: () => true, prompt: () => "", alert: () => {}, addEventListener: () => {},
    location: { hash: "", href: "https://studio.test/cast", pathname: "/cast" },
  };
  g.document = {
    querySelector: (s: string) => elFor(s),
    querySelectorAll: () => [],
    createElement: () => new El(),
    addEventListener: (ev: string, fn: Listener) => {
      if (!docListeners[ev]) docListeners[ev] = [];
      docListeners[ev].push(fn);
    },
    body: new El(),
  };
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.fetch = async (path: string, init?: { method?: string; body?: string }) => {
    const url = String(path);
    fetchCalls.push({ url, method: (init && init.method) || "GET", body: (init && init.body) || "" });
    if (url === "/api/cast") {
      return reply(200, { cast: [castRow()] });
    }
    if (url === "/api/voices") return reply(200, { voices: [] });
    if (url === "/api/models") return reply(200, { models: [] });
    if (url === WAN_URL || url === SDXL_URL) {
      if (trainStatus === 501) return reply(501, { error: OPERATOR_501 });
      if (trainStatus === 500) return reply(500, { error: "bundle assembly failed" });
      return reply(200, { ok: true, jobId: "j1", cast: castRow() });
    }
    return reply(200, {});
  };
  (0, eval)(readFileSync("public/model-catalog.js", "utf8"));
  (0, eval)(readFileSync("public/cast.js", "utf8"));
});

afterEach(() => { vi.useRealTimers(); });

function castRow() {
  return {
    id: CAST_ID, name: "Ripley", slug: "ripley", bible: "", voice_id: "",
    portrait_key: "cast/7/portrait.png", ref_keys: [], source_keys: [],
    lora_status: "none", lora_job_id: null, lora_error: null,
    wan_lora_key_high: null, wan_lora_key_low: null,
  };
}

// cast.js resolves entirely through promises; nothing on the click path waits on a timer.
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }

async function boot() {
  for (const fn of docListeners["DOMContentLoaded"] || []) fn();
  await flush();
}

function clicksOn(sel: string): Listener[] { return elFor(sel).listeners["click"] || []; }

async function click(sel: string) {
  for (const fn of clicksOn(sel)) await fn();
  await flush();
}

function wanStatus(): string { return elFor("#cast-wan-lora-status-text").textContent; }

function trainCalls(): Call[] { return fetchCalls.filter((c) => c.url.indexOf("/train") !== -1); }

describe("#329 the /cast Wan LoRA button submits the WAN route", () => {
  it("CONTROL: the harness boots, the shipped wire() registers the real click listener, and fetches record", async () => {
    await boot();
    expect(fetchCalls.map((c) => c.url)).toContain("/api/cast");
    expect(clicksOn("#cast-wan-lora-train-btn").length).toBe(1);
    expect(clicksOn("#cast-lora-train-btn").length).toBe(1);
  });

  it("CONTROL: the 501 fixture really does carry the binding name, so the no-leak assertion can go red", () => {
    expect(OPERATOR_501).toContain(BINDING);
  });

  it("posts the WAN route, never the family-resolving shared route", async () => {
    await boot();
    await click("#cast-wan-lora-train-btn");
    expect(trainCalls().map((c) => c.url)).toEqual([WAN_URL]);
    expect(trainCalls()[0].method).toBe("POST");
    expect(trainCalls().map((c) => c.url)).not.toContain(SDXL_URL);
  });

  it("a 501 says something true and leaks NO binding name to the tenant", async () => {
    trainStatus = 501;
    await boot();
    await click("#cast-wan-lora-train-btn");
    expect(wanStatus()).toBe(PRODUCT_501);
    expect(wanStatus()).not.toContain(BINDING);
    expect(wanStatus()).not.toContain("RUNPOD");
    expect(wanStatus()).not.toContain("not configured on this host");
  });

  it("a NON-501 failure keeps the server-supplied message, unchanged", async () => {
    trainStatus = 500;
    await boot();
    await click("#cast-wan-lora-train-btn");
    expect(wanStatus()).toBe("submit failed: bundle assembly failed");
  });

  it("leaves the SDXL button alone: still /train-lora, still explicit model_family sdxl", async () => {
    await boot();
    await click("#cast-lora-train-btn");
    expect(trainCalls().map((c) => c.url)).toEqual([SDXL_URL]);
    expect(JSON.parse(trainCalls()[0].body)).toEqual({ model_family: "sdxl" });
  });
});
