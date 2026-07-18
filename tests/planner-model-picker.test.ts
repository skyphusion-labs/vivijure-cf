/// <reference types="node" />
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// cf#62 (FE-4): the planning-model picker is a PROJECTION of the installed plan.enhance
// modules (GET /api/storyboard/models), so the catalog arrives asynchronously and its
// contents legitimately change between sessions -- a module uninstalled, a config_schema
// enum edited, a third-party plan.enhance swapped in.
//
// A bare `select.value = savedId` lost in two ways, and both are covered here:
//   1. RACE -- a restore running before loadModels built the options was dropped silently,
//      even for a perfectly valid id.
//   2. STALE -- an id no longer in the catalog set .value to "" with no message, so the
//      user's saved preference vanished while the picker showed something else.
//
// This evals the REAL shipped planner-plan.js against a minimal stub scope (no jsdom,
// matching the repo's Node-env test pattern) and asserts the shipped loadModels.

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
    else { this.options = [new OptEl()]; this._selIdx = 0; } // the 'loading models...' markup path
  }
  get innerHTML() { return ""; }
  appendChild(o: OptEl) {
    this.options.push(o);
    if (this._selIdx === -1) this._selIdx = 0; // browser default: first option
    return o;
  }
  get value() { return this._selIdx >= 0 && this.options[this._selIdx] ? this.options[this._selIdx].value : ""; }
  set value(v: string) { this._selIdx = this.options.findIndex((o) => o.value === v); }
}

let sel: SelectStub;
let statusCalls: Array<{ text: string; kind: string }>;
let g: Record<string, unknown>;

function serveModels(models: unknown[] | null, ok = true) {
  g.fetch = async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => (models === null ? {} : { models }),
  });
}

const MODELS = [
  { id: "anthropic/claude-opus-4-8", label: "plan-enhance · opus" },
  { id: "anthropic/claude-sonnet-5", label: "plan-enhance · sonnet-5" },
];

beforeAll(() => {
  g = globalThis as unknown as Record<string, unknown>;
  const src = readFileSync("public/planner-plan.js", "utf8");
  g.$ = (s: string) => (s === "#planner-model" ? sel : null);
  g.setStatus = (text: string, kind: string) => { statusCalls.push({ text, kind }); };
  g.document = { createElement: () => new OptEl() };
  (0, eval)(src);
});

beforeEach(() => {
  sel = new SelectStub();
  statusCalls = [];
});

const loadModels = () => (globalThis as unknown as { loadModels: () => Promise<void> }).loadModels();
const selectPlanningModel = (v: string) =>
  (globalThis as unknown as { selectPlanningModel: (v: string) => void }).selectPlanningModel(v);

describe("loadModels (cf#62 FE-4: the catalog is projected, so restores must not race or vanish)", () => {
  it("POSITIVE CONTROL: builds the picker from the response and enables it", async () => {
    serveModels(MODELS);
    await loadModels();
    expect(sel.options.map((o) => o.value)).toEqual([
      "anthropic/claude-opus-4-8",
      "anthropic/claude-sonnet-5",
    ]);
    expect(sel.options[1].textContent).toBe("plan-enhance · sonnet-5"); // label, not id
    expect(sel.disabled).toBe(false);
    expect(statusCalls).toEqual([]); // nothing dropped, so nothing to report
  });

  it("CONTROL: the status stub actually records (so the silence assertions above mean something)", () => {
    (globalThis as unknown as { setStatus: (t: string, k: string) => void }).setStatus("probe", "error");
    expect(statusCalls).toEqual([{ text: "probe", kind: "error" }]);
  });

  it("RACE: a restore that runs BEFORE the catalog loads is honored, not dropped", async () => {
    selectPlanningModel("anthropic/claude-sonnet-5"); // options do not exist yet
    expect(sel.value).toBe(""); // nothing to select against -- the old bug lost it here
    serveModels(MODELS);
    await loadModels();
    expect(sel.value).toBe("anthropic/claude-sonnet-5"); // survived via data-pending-value
  });

  it("STALE: an id the catalog no longer serves drops VISIBLY and lands on a real model", async () => {
    selectPlanningModel("anthropic/claude-opus-4-7"); // a model this deploy no longer serves
    serveModels(MODELS);
    await loadModels();
    expect(sel.value).toBe("anthropic/claude-opus-4-8"); // a REAL id, never ""
    expect(statusCalls.length).toBe(1);
    expect(statusCalls[0].text).toContain("anthropic/claude-opus-4-7"); // names what was lost
    expect(statusCalls[0].text).toContain("no longer available");
    expect(statusCalls[0].kind).toBe("error"); // surfaced, not swallowed
  });

  it("an EMPTY catalog degrades honestly and PRESERVES the pending restore", async () => {
    selectPlanningModel("anthropic/claude-sonnet-5");
    serveModels([]); // no plan.enhance module installed
    await loadModels();
    expect(sel.options.length).toBe(1);
    expect(sel.options[0].disabled).toBe(true);
    expect(sel.value).toBe(""); // plan() blocks on this, honestly
    // installing a module and reloading must still land on the saved choice
    expect(sel.dataset.pendingValue).toBe("anthropic/claude-sonnet-5");
    serveModels(MODELS);
    await loadModels();
    expect(sel.value).toBe("anthropic/claude-sonnet-5");
  });

  it("a reload with no pending restore preserves the CURRENT selection", async () => {
    serveModels(MODELS);
    await loadModels();
    sel.value = "anthropic/claude-sonnet-5";
    await loadModels();
    expect(sel.value).toBe("anthropic/claude-sonnet-5");
  });

  it("a failed fetch reports the error and does not strand a pending restore", async () => {
    selectPlanningModel("anthropic/claude-sonnet-5");
    serveModels(null, false); // HTTP 500
    await loadModels();
    expect(sel.options.some((o) => /failed to load models/i.test(o.textContent))).toBe(true);
    serveModels(MODELS); // the retry still honors it
    await loadModels();
    expect(sel.value).toBe("anthropic/claude-sonnet-5");
  });
});

// ---------------------------------------------------------------------------
// Found by DRIVING THE REAL PANEL during the cf#62 Lane C parity gate, not by inspection:
// selectPlanningModel only STASHED the desired id, so a restore arriving AFTER the catalog
// was already loaded (the common case -- switching projects mid-session) left the picker
// BLANK and SILENT until the next loadModels(), which in normal use may never come. The
// unit tests above all happened to set the pending value BEFORE a load, so they never saw it.
describe("selectPlanningModel with the catalog ALREADY loaded (mid-session restore)", () => {
  async function loaded() {
    serveModels(MODELS);
    await loadModels();
    statusCalls = [];
  }

  it("a VALID id applies immediately, no reload required", async () => {
    await loaded();
    selectPlanningModel("anthropic/claude-sonnet-5");
    expect(sel.value).toBe("anthropic/claude-sonnet-5"); // NOT "" pending a future load
    expect(statusCalls).toEqual([]);
  });

  it("a STALE id resolves immediately and visibly -- never a blank, silent picker", () => {
    return loaded().then(() => {
      selectPlanningModel("anthropic/claude-opus-4-7-RETIRED");
      expect(sel.value).toBe("anthropic/claude-opus-4-8"); // a REAL model, right now
      expect(sel.value).not.toBe("");
      expect(statusCalls.length).toBe(1);
      expect(statusCalls[0].text).toContain("anthropic/claude-opus-4-7-RETIRED");
      expect(statusCalls[0].kind).toBe("error");
    });
  });

  it("resolving immediately clears the pending stash (no delayed second apply)", async () => {
    await loaded();
    selectPlanningModel("anthropic/claude-sonnet-5");
    expect(sel.dataset.pendingValue).toBeUndefined();
  });

  it("placeholder-only pickers are NOT mistaken for a loaded catalog", async () => {
    serveModels([]); // empty catalog: one disabled placeholder with an empty value
    await loadModels();
    statusCalls = [];
    selectPlanningModel("anthropic/claude-sonnet-5");
    // Must STASH (the catalog is not really loaded), not "resolve" against a placeholder.
    expect(sel.dataset.pendingValue).toBe("anthropic/claude-sonnet-5");
    expect(statusCalls).toEqual([]); // nothing was lost, so nothing is reported
    serveModels(MODELS);
    await loadModels();
    expect(sel.value).toBe("anthropic/claude-sonnet-5");
  });
});
