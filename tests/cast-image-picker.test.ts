/// <reference types="node" />
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// cf#129: the three cast image pickers (training set, portrait gen, multi-scene) used to be
// fed by a hardcoded TRAINING_MODELS array inside cast.js. That made the panel a THIRD
// catalog disagreeing with both hosts, and -- the actual defect -- the pickers stayed fully
// populated when NO image-capable module was installed, so the user picked a model nothing
// could serve and only found out at POST /api/chat time (the cf#135 stale-state family).
//
// They now render GET /api/models filtered on type==="image", through the shared
// model-catalog.js render path. This suite evals the REAL shipped model-catalog.js + cast.js
// against a stub scope and asserts the shipped hydrateImagePicker.

class OptEl {
  tagName = "option";
  value = "";
  disabled = false;
  textContent = "";
}

class SelectStub {
  options: OptEl[] = [];
  dataset: Record<string, string> = {};
  disabled = false;
  _selIdx = -1;
  set innerHTML(v: string) {
    if (v === "") { this.options = []; this._selIdx = -1; }
    else { this.options = [new OptEl()]; this._selIdx = 0; }
  }
  get innerHTML() { return ""; }
  appendChild(o: OptEl) {
    this.options.push(o);
    if (this._selIdx === -1) this._selIdx = 0;
    return o;
  }
  get value() { return this._selIdx >= 0 && this.options[this._selIdx] ? this.options[this._selIdx].value : ""; }
  set value(v: string) { this._selIdx = this.options.findIndex((o) => o.value === v); }
}

const SEL = "#cast-training-model";
let sel: SelectStub;
let fetchCalls: string[];
let g: Record<string, unknown>;

function serve(models: unknown[] | null, ok = true, status = 200) {
  g.fetch = async (path: string) => {
    fetchCalls.push(String(path));
    return {
      ok,
      status,
      json: async () => (models === null ? { error: "boom" } : { models }),
    };
  };
}

const ROWS = [
  { id: "acme/planner-xl", label: "ACME · planner", group: "Planning · acme", type: "chat", capabilities: [] },
  { id: "@cf/black-forest-labs/flux-2-klein-9b", label: "FLUX 2 Klein 9B", group: "Image Gen", type: "image", capabilities: [] },
  { id: "google/nano-banana-pro", label: "Nano Banana Pro", group: "Image Gen", type: "image", capabilities: [], provider: "google" },
];

const helpers = () => (globalThis as unknown as { window: { __castHelpers: {
  hydrateImagePicker: (s: string) => Promise<void>;
  getSelectedTrainingModelId: () => string;
} } }).window.__castHelpers;

// The catalog cache inside cast.js is module-level and lives for the PAGE LIFETIME, which is
// the correct production behaviour: one fetch per load, shared by all three pickers. So each
// test re-evals the shipped files to model a FRESH PAGE LOAD rather than reaching into the
// closure to reset it. Reusing one eval across tests silently served test 2 the catalog that
// test 1 fetched, which is exactly how a cache bug would hide here.
beforeEach(() => {
  g = globalThis as unknown as Record<string, unknown>;
  g.window = { addEventListener: () => {}, confirm: () => true, prompt: () => "" };
  g.document = {
    querySelector: (s: string) => (s === SEL ? sel : null),
    createElement: () => new OptEl(),
    addEventListener: () => {},
  };
  g.localStorage = { getItem: () => null, setItem: () => {} };
  sel = new SelectStub();
  fetchCalls = [];
  (0, eval)(readFileSync("public/model-catalog.js", "utf8"));
  (0, eval)(readFileSync("public/cast.js", "utf8"));
});

describe("cast image pickers render the PROJECTED catalog (cf#129)", () => {
  it("POSITIVE CONTROL: builds only the image rows, by label, and hits /api/models", async () => {
    serve(ROWS);
    await helpers().hydrateImagePicker(SEL);
    expect(sel.options.map((o) => o.value)).toEqual([
      "@cf/black-forest-labs/flux-2-klein-9b",
      "google/nano-banana-pro",
    ]);
    expect(sel.options[1].textContent).toBe("Nano Banana Pro");
    expect(sel.disabled).toBe(false);
    expect(fetchCalls).toEqual(["/api/models"]);
  });

  it("CONTROL: the fetch stub actually records (so the call assertions above mean something)", async () => {
    serve(ROWS);
    await helpers().hydrateImagePicker(SEL);
    expect(fetchCalls.length).toBe(1);
  });

  it("EXCLUDES chat rows -- an image picker never offers a planning model", async () => {
    serve(ROWS);
    await helpers().hydrateImagePicker(SEL);
    expect(sel.options.map((o) => o.value)).not.toContain("acme/planner-xl");
  });

  it("HONEST FAIL: no image rows renders a visible disabled state naming what is missing", async () => {
    serve([ROWS[0]]); // planning rows only: no image-capable module installed
    await helpers().hydrateImagePicker(SEL);
    expect(sel.options.length).toBe(1);
    expect(sel.options[0].disabled).toBe(true);
    expect(sel.options[0].textContent).toBe("no image models available");
    expect(sel.value).toBe(""); // callers gate on this, honestly
  });

  it("HONEST FAIL: an empty catalog does NOT fall back to a hardcoded model id", async () => {
    serve([]);
    await helpers().hydrateImagePicker(SEL);
    // the pre-cf#129 behaviour was a populated picker defaulting to flux-2-klein-9b
    expect(sel.options.map((o) => o.value)).toEqual([""]);
    expect(helpers().getSelectedTrainingModelId()).toBe("");
  });

  it("a failed load reports it and stays RETRYABLE (the cached promise is dropped)", async () => {
    serve(null, false, 500);
    await helpers().hydrateImagePicker(SEL);
    expect(sel.options.some((o) => /failed to load models/i.test(o.textContent))).toBe(true);
    // the retry must actually re-fetch, not inherit the failure forever
    serve(ROWS);
    await helpers().hydrateImagePicker(SEL);
    expect(sel.options.map((o) => o.value)).toContain("google/nano-banana-pro");
  });

  it("does NOT refetch once real rows are present (guard tests rows, not option count)", async () => {
    serve(ROWS);
    await helpers().hydrateImagePicker(SEL);
    const first = fetchCalls.length;
    await helpers().hydrateImagePicker(SEL);
    expect(fetchCalls.length).toBe(first);
  });
});
