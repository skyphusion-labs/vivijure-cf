/// <reference types="node" />
// The cast page shows the "Wan LoRA (optional, slow)" pane only when the alibaba-wan-lora door is
// installed AND this host can train a Wan LoRA. Before this, the module registry alone decided, so a
// host without the Wan train endpoint showed a pane whose button could only end in the 501.
//
// Two halves, both against the shipped artifact:
//   SERVER: GET /api/cast reports `wan_lora_trainable` from RUNPOD_WAN_TRAIN_ENDPOINT_ID, as a
//           boolean only, and fails closed when the secret read throws.
//   CLIENT: the REAL public/cast.js, booted through its own DOMContentLoaded wire(), keeps the pane
//           hidden on false, missing or error, and shows it on true with the door installed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import type { Env } from "../src/env";

const ENDPOINT_ID = "wan-train-endpoint-fixture-123";

// ---------------------------------------------------------------- server ----

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function dbStub() {
  const stmt = {
    bind: () => stmt,
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => ({ success: true }),
  };
  return { prepare: () => stmt };
}

function serverEnv(extra: Record<string, unknown> = {}) {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    DB: dbStub(),
    ...extra,
  } as unknown as Env;
}

async function listCast(env: Env) {
  const res = await worker.fetch(new Request("https://studio.example/api/cast"), env, ctx);
  const text = await res.text();
  return { res, text, body: JSON.parse(text) as Record<string, unknown> };
}

describe("GET /api/cast wan_lora_trainable", () => {
  it("is true when the host has the Wan train endpoint wired (plain string)", async () => {
    const { res, body } = await listCast(serverEnv({ RUNPOD_WAN_TRAIN_ENDPOINT_ID: ENDPOINT_ID }));
    expect(res.status).toBe(200);
    expect(body.wan_lora_trainable).toBe(true);
    expect(Array.isArray(body.cast)).toBe(true);
  });

  it("is true when the endpoint comes from a Secrets Store binding", async () => {
    const env = serverEnv({ RUNPOD_WAN_TRAIN_ENDPOINT_ID: { get: async () => ENDPOINT_ID } });
    const { body } = await listCast(env);
    expect(body.wan_lora_trainable).toBe(true);
  });

  it("is false when the env is unset", async () => {
    const { res, body } = await listCast(serverEnv());
    expect(res.status).toBe(200);
    expect(body.wan_lora_trainable).toBe(false);
  });

  it("is false when the env is blank", async () => {
    const { body } = await listCast(serverEnv({ RUNPOD_WAN_TRAIN_ENDPOINT_ID: "   " }));
    expect(body.wan_lora_trainable).toBe(false);
  });

  it("fails closed: a secret read that throws reports false and the list still loads", async () => {
    const env = serverEnv({
      RUNPOD_WAN_TRAIN_ENDPOINT_ID: { get: async () => { throw new Error("secrets store down"); } },
    });
    const { res, body } = await listCast(env);
    expect(res.status).toBe(200);
    expect(body.wan_lora_trainable).toBe(false);
    expect(Array.isArray(body.cast)).toBe(true);
  });

  it("never returns the endpoint id itself", async () => {
    const { text } = await listCast(serverEnv({ RUNPOD_WAN_TRAIN_ENDPOINT_ID: ENDPOINT_ID }));
    expect(text).not.toContain(ENDPOINT_ID);
  });
});

// ---------------------------------------------------------------- client ----

type Listener = (...a: unknown[]) => unknown;

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

let els: Map<string, El>;
let docListeners: Record<string, Listener[]>;

// What GET /api/cast answers in each case: a body with the field, a body without it, or an error.
type ListReply = { kind: "field"; value: unknown } | { kind: "missing" } | { kind: "error" };
let listReply: ListReply;
// What the module registry answers: installed, not installed, or a failed load.
type RegReply = "installed" | "absent" | "error";
let regReply: RegReply;

function elFor(sel: string): El {
  let e = els.get(sel);
  if (!e) { e = new El(); els.set(sel, e); }
  return e;
}

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  vi.useFakeTimers();
  els = new Map();
  docListeners = {};
  listReply = { kind: "field", value: true };
  regReply = "installed";
  // The pane ships hidden in cast.html; the stub starts it the same way.
  elFor("#cast-wan-lora-pane").hidden = true;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    confirm: () => true, prompt: () => "", alert: () => {}, addEventListener: () => {},
    location: { hash: "", href: "https://studio.test/cast", pathname: "/cast" },
    moduleRegistry: {
      load: async () => {
        if (regReply === "error") throw new Error("registry down");
        return {
          modules: regReply === "installed"
            ? [{ name: "image-generate" }, { name: "alibaba-wan-lora" }]
            : [{ name: "image-generate" }],
        };
      },
    },
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
  g.fetch = async (path: string) => {
    const url = String(path);
    if (url === "/api/cast") {
      if (listReply.kind === "error") return reply(500, { error: "db down" });
      if (listReply.kind === "missing") return reply(200, { cast: [] });
      return reply(200, { cast: [], wan_lora_trainable: listReply.value });
    }
    if (url === "/api/voices") return reply(200, { voices: [] });
    if (url === "/api/models") return reply(200, { models: [] });
    return reply(200, {});
  };
  (0, eval)(readFileSync("public/model-catalog.js", "utf8"));
  (0, eval)(readFileSync("public/cast.js", "utf8"));
});

afterEach(() => { vi.useRealTimers(); });

async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }

async function boot() {
  for (const fn of docListeners["DOMContentLoaded"] || []) fn();
  await flush();
}

function paneHidden(): boolean { return elFor("#cast-wan-lora-pane").hidden; }

describe("cast page Wan LoRA pane: door installed AND host can train", () => {
  it("CONTROL: the harness boots wire() and the pane can be revealed at all", async () => {
    await boot();
    expect(paneHidden()).toBe(false);
  });

  it("shows on wan_lora_trainable true when the door is installed", async () => {
    listReply = { kind: "field", value: true };
    await boot();
    expect(paneHidden()).toBe(false);
  });

  it("stays hidden on wan_lora_trainable false", async () => {
    listReply = { kind: "field", value: false };
    await boot();
    expect(paneHidden()).toBe(true);
  });

  it("stays hidden when the field is missing", async () => {
    listReply = { kind: "missing" };
    await boot();
    expect(paneHidden()).toBe(true);
  });

  it("stays hidden when the field is truthy but not the boolean true", async () => {
    listReply = { kind: "field", value: "true" };
    await boot();
    expect(paneHidden()).toBe(true);
  });

  it("stays hidden when GET /api/cast errors", async () => {
    listReply = { kind: "error" };
    await boot();
    expect(paneHidden()).toBe(true);
  });

  it("stays hidden on a trainable host when the door is not installed", async () => {
    regReply = "absent";
    await boot();
    expect(paneHidden()).toBe(true);
  });

  it("stays hidden on a trainable host when the module registry fails to load", async () => {
    regReply = "error";
    await boot();
    expect(paneHidden()).toBe(true);
  });
});
