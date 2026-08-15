/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import checks from "../public/hook-availability-checks.js";
import {
  VIDEO_FINISH_UNAVAILABLE_REASON,
  VIDEO_FINISH_UNPROVISIONABLE_REASON,
} from "../src/video-finish-availability";

// THE SHARED cf#98 GATE'S TWO NEW RELATIONSHIPS (cf#229 advisory, cf#234 container scope).
//
// This evals the REAL browser IIFE (public/hook-availability.js) against a hand-rolled document, the
// repo's established pattern for panel assets (see planner-render-config.test.ts): no jsdom, no build
// step. The stub is deliberately small and supports ONLY the selector forms the gate actually uses;
// it is a decision-path test, and the shipped artifact is proven in a browser before release.
//
// The distinction under test is the whole of cf#229: REQUIRED disables, ADVISORY does not. A gate
// that dims a working control is the same dishonesty as a button that 422s, pointed the other way.

type Attrs = Record<string, string>;

function matchesSimple(el: El, sel: string): boolean {
  const tag = /^[a-z]+/i.exec(sel);
  if (tag && el.tagName !== tag[0].toUpperCase()) return false;
  for (const [, name, val] of sel.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)) {
    const have = el.getAttribute(name);
    if (have === null) return false;
    if (val !== undefined && have !== val) return false;
  }
  for (const [, cls] of sel.matchAll(/\.([a-z-]+)/g)) if (!el.classList.contains(cls)) return false;
  return true;
}

function matches(el: El, selector: string): boolean {
  return selector.split(",").map((s) => s.trim()).filter(Boolean).some((s) => matchesSimple(el, s));
}

class El {
  tagName: string;
  attrs: Attrs = {};
  dataset: Record<string, string> = {};
  children: El[] = [];
  parentNode: El | null = null;
  className = "";
  disabled = false;
  textContent = "";
  constructor(tag: string, attrs: Attrs = {}, kids: El[] = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    for (const k of kids) this.append(k);
  }
  get title(): string { return this.attrs.title ?? ""; }
  set title(v: string) { this.attrs.title = v; }
  get classList() {
    const toks = () => (this.className ? this.className.split(/\s+/).filter(Boolean) : []);
    return {
      add: (c: string) => { const t = toks(); if (!t.includes(c)) t.push(c); this.className = t.join(" "); },
      remove: (c: string) => { this.className = toks().filter((x) => x !== c).join(" "); },
      contains: (c: string) => toks().includes(c),
    };
  }
  getAttribute(n: string): string | null { return this.attrs[n] ?? null; }
  setAttribute(n: string, v: string): void { this.attrs[n] = v; }
  removeAttribute(n: string): void { delete this.attrs[n]; }
  get parentElement(): El | null { return this.parentNode; }
  append(child: El): El { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(node: El, ref: El | null): El {
    node.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node); else this.children.splice(i, 0, node);
    return node;
  }
  removeChild(node: El): El {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  get nextElementSibling(): El | null {
    if (!this.parentNode) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] ?? null;
  }
  get nextSibling(): El | null { return this.nextElementSibling; }
  descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelectorAll(sel: string): El[] { return this.descendants().filter((e) => matches(e, sel)); }
  closest(sel: string): El | null {
    let cur: El | null = this;
    while (cur) { if (matches(cur, sel)) return cur; cur = cur.parentNode; }
    return null;
  }
}

const SRC = readFileSync("public/hook-availability.js", "utf8");
// Read from the module, never hand-copied: a fixture with its own copy of the sentence is a place
// a copy-swap silently fails to reach, and on the local twin it is where the wrong panel's wording
// would hide (local#226).
const REASON = VIDEO_FINISH_UNAVAILABLE_REASON;

function fixture(): { doc: El; get: (id: string) => El } {
  const el = (tag: string, attrs: Attrs = {}, kids: El[] = []) => new El(tag, attrs, kids);
  const doc = el("body", {}, [
    // a projected module section, container-scoped on a hook the host cannot serve
    el("details", { id: "sec-master", "data-hook": "master", "data-hook-scope": "container" }, [
      el("summary", { id: "sec-master-summary" }),
      el("input", { id: "master-lufs" }),
      el("select", { id: "master-format" }),
    ]),
    // a projected module section on a hook that IS served
    el("details", { id: "sec-keyframe", "data-hook": "keyframe", "data-hook-scope": "container" }, [
      el("input", { id: "keyframe-steps" }),
    ]),
    // a control that needs the missing capability outright
    el("button", { id: "add-audio", "data-hook": "capability:video-finish" }),
    // the module-host page's stage projection (cf#234). Two things the planner fixture cannot
    // stand in for: the card is an ARTICLE, not a <details>, and its fields sit two levels down
    // inside the chain list. `notify` is the hook under test because the stage projection is the
    // ONLY surface in the studio that can disclose it (no planner control exists, and the
    // notification TOGGLE is a different thing entirely).
    el("article", { id: "stage-notify", "data-hook": "notify", "data-hook-scope": "container" }, [
      el("div", { id: "stage-notify-head" }),
      el("ol", {}, [el("li", {}, [el("div", {}, [el("input", { id: "stage-notify-retries" })])])]),
    ]),
    // a stage whose hook the host serves, so the fixture can tell gating from blanket dimming
    el("article", { id: "stage-speech", "data-hook": "speech", "data-hook-scope": "container" }, [
      el("select", { id: "stage-speech-voice" }),
    ]),
    // a control that WORKS but cannot deliver into a film
    el("details", { id: "music-block", "data-hook-advisory": "capability:video-finish" }, [
      el("textarea", { id: "music-prompt" }),
      el("button", { id: "music-gen" }),
    ]),
  ]);
  const byId = (id: string): El => {
    const found = doc.descendants().find((e) => e.getAttribute("id") === id);
    if (!found) throw new Error("fixture has no #" + id);
    return found;
  };
  return { doc, get: byId };
}

async function runGate(hooksUnavailable: Record<string, string> | null) {
  const { doc, get } = fixture();
  const document = Object.assign(doc, {
    readyState: "complete",
    addEventListener: () => {},
    createElement: (tag: string) => new El(tag),
  });
  const payload = hooksUnavailable ? { host: { hooks_unavailable: hooksUnavailable } } : { host: {} };
  const fetchStub = async () => ({ ok: true, json: async () => payload });
  // cf#580: the gate reads the SHARED per-page memo now, so the harness mirrors the page: build
  // module-registry.js with the transport, put it on the window, then evaluate the gate. It no
  // longer stubs a bare fetch, because that would exercise a path the gate does not take.
  const regSrc = readFileSync("public/module-registry.js", "utf8");
  const regScope: { moduleRegistry?: Record<string, (...a: unknown[]) => unknown> } = {};
  new Function("window", regSrc)(regScope);
  (regScope.moduleRegistry!.setTransport as (f: unknown) => void)(fetchStub);
  const window: Record<string, unknown> = {
    hookAvailabilityChecks: checks,
    moduleRegistry: regScope.moduleRegistry,
  };
  new Function("window", "document", SRC)(window, document);
  await (window.hookAvailability as { ready: Promise<unknown> }).ready;
  return { get, doc };
}

const UNAVAILABLE = {
  "capability:video-finish": REASON,
  master: REASON,
  "film.finish": REASON,
  notify: REASON,
};

describe("cf#234: container scope disables a whole projected section, and says why ONCE", () => {
  it("disables every field in the section and emits exactly one note", async () => {
    const { get } = await runGate(UNAVAILABLE);
    const section = get("sec-master");
    expect(section.classList.contains("hook-unavailable")).toBe(true);
    expect(get("master-lufs").disabled, "a section that only DIMS still takes input").toBe(true);
    expect(get("master-format").disabled).toBe(true);
    const note = section.nextElementSibling;
    expect(note?.className).toBe("hook-unavailable-note");
    expect(note?.textContent).toBe(REASON);
    // ONE note for the section, and NONE inside it: tagging every generated field (option (c))
    // buried the panel in repeated sentences, which is why container mode exists.
    const inside = section.descendants().filter((e) => e.className === "hook-unavailable-note");
    expect(inside.length, "the section states its reason once, on itself").toBe(0);
  });

  it("leaves a section whose hook IS served completely alone", async () => {
    const { get } = await runGate(UNAVAILABLE);
    expect(get("sec-keyframe").classList.contains("hook-unavailable")).toBe(false);
    expect(get("keyframe-steps").disabled).toBe(false);
    expect(get("sec-keyframe").nextElementSibling?.className ?? "").not.toContain("note");
  });
});

describe("cf#234: the module-host stage projection gates like any other section", () => {
  it("reaches fields nested inside the card and states the reason once, on the card", async () => {
    const { get } = await runGate(UNAVAILABLE);
    const card = get("stage-notify");
    expect(card.classList.contains("hook-unavailable")).toBe(true);
    expect(
      get("stage-notify-retries").disabled,
      "container scope must reach a field nested in the chain list, not just direct children",
    ).toBe(true);
    expect(card.nextElementSibling?.className).toBe("hook-unavailable-note");
    expect(card.nextElementSibling?.textContent).toBe(REASON);
    expect(card.descendants().filter((e) => e.className === "hook-unavailable-note").length).toBe(0);
  });

  it("is the ONLY surface that can disclose notify, and it does", async () => {
    // notify is skipped from the planner panel by design and has no control of its own anywhere
    // else. If this stage card did not gate, an unservable notify would be reported by the host
    // and shown by nothing.
    const { get } = await runGate(UNAVAILABLE);
    expect(get("stage-notify").nextElementSibling?.textContent).toBe(REASON);
  });

  it("leaves a stage the host DOES serve completely alone", async () => {
    const { get } = await runGate(UNAVAILABLE);
    expect(get("stage-speech").classList.contains("hook-unavailable")).toBe(false);
    expect(get("stage-speech-voice").disabled).toBe(false);
    expect(get("stage-speech").nextElementSibling?.className ?? "").not.toContain("note");
  });
});

describe("cf#229: ADVISORY states the limit and disables NOTHING", () => {
  it("annotates the bed generator without touching a single control", async () => {
    const { get } = await runGate(UNAVAILABLE);
    const block = get("music-block");
    expect(block.getAttribute("aria-disabled"), "an advisory control is not disabled").toBeNull();
    expect(block.classList.contains("hook-unavailable"), "and is not dimmed like one").toBe(false);
    expect(get("music-prompt").disabled).toBe(false);
    expect(get("music-gen").disabled).toBe(false);
    const note = block.nextElementSibling;
    expect(note?.className).toBe("hook-advisory-note");
    expect(note?.textContent).toBe(REASON);
  });

  it("the advisory note obeys THIS panel's reader properties, never a pinned sentence", async () => {
    // Same doctrine as the required note (#239): guard the property, not the wording. What must
    // hold for an advisory note on the HOSTED panel under any rewrite: it exists and is readable,
    // it never tells a tenant to set a host environment variable, and it still says what they DO
    // get. The local twin asserts its own reader's properties, which are deliberately different.
    const { get } = await runGate(UNAVAILABLE);
    const note = get("music-block").nextElementSibling;
    expect(note?.className).toBe("hook-advisory-note");
    const text = String(note?.textContent ?? "");
    expect(text.trim().length, "an advisory that says nothing is not a disclosure").toBeGreaterThan(0);
    expect(text).not.toMatch(/VIDEO_FINISH_URL|Set [A-Z_]+/);
    expect(text).toMatch(/clips/);
  });

  it("a REQUIRED declaration on the same capability still disables", async () => {
    // The pair that proves the distinction is real: same key, same map, opposite outcome, decided
    // only by which relationship the control declared.
    const { get } = await runGate(UNAVAILABLE);
    const btn = get("add-audio");
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.nextElementSibling?.textContent).toBe(REASON);
  });
});

describe("POSITIVE CONTROL: the gate is inert when the host reports nothing", () => {
  it("a fully provisioned host leaves every control live and unannotated", async () => {
    // Without this, every assertion above could be measuring the fixture rather than the map.
    const { get, doc } = await runGate(null);
    for (const id of ["master-lufs", "master-format", "keyframe-steps", "music-prompt", "music-gen", "add-audio", "stage-notify-retries", "stage-speech-voice"]) {
      expect(get(id).disabled, id).toBe(false);
    }
    expect(doc.descendants().filter((e) => e.className.includes("note")).length).toBe(0);
  });
});

// control-plane#136: the panel prints whatever the host says, including the sentence for the state
// that has only now become reachable.
//
// WHY THIS EARNS ITS PLACE rather than restating the tests above: the plane can now put a studio in
// the `unprovisionable` state, and the whole panel-side design is that the reason string is OPAQUE
// to the gate. This is the test that fails if anyone ever branches on WHICH sentence arrived --
// a per-state branch in the panel is exactly the hardcoded, non-projected shape this repo refuses,
// and it would strand the next state the plane learns to write.
describe("control-plane#136: the gate is copy-AGNOSTIC, so a new host sentence needs no panel change", () => {
  const UNPROVISIONABLE = {
    "capability:video-finish": VIDEO_FINISH_UNPROVISIONABLE_REASON,
    master: VIDEO_FINISH_UNPROVISIONABLE_REASON,
    "film.finish": VIDEO_FINISH_UNPROVISIONABLE_REASON,
    notify: VIDEO_FINISH_UNPROVISIONABLE_REASON,
  };

  it("renders the unprovisionable sentence VERBATIM, required and advisory alike", async () => {
    const { get } = await runGate(UNPROVISIONABLE);
    expect(get("sec-master").nextElementSibling?.textContent).toBe(VIDEO_FINISH_UNPROVISIONABLE_REASON);
    expect(get("music-block").nextElementSibling?.textContent).toBe(VIDEO_FINISH_UNPROVISIONABLE_REASON);
    // The sentences differ, so this is not the same assertion as the provisionable one above.
    expect(VIDEO_FINISH_UNPROVISIONABLE_REASON).not.toBe(VIDEO_FINISH_UNAVAILABLE_REASON);
  });

  it("gates identically in both states: same controls disabled, same advisory left alone", async () => {
    const { get } = await runGate(UNPROVISIONABLE);
    // Which controls die is a property of the CAPABILITY, never of the words explaining it.
    expect(get("sec-master").classList.contains("hook-unavailable")).toBe(true);
    expect(get("master-lufs").disabled).toBe(true);
    expect(get("add-audio").disabled).toBe(true);
    expect(get("music-prompt").disabled, "an advisory control is never disabled").toBe(false);
  });

  it("the unprovisionable sentence keeps this panel READER properties", async () => {
    // Same doctrine as the notes above: guard the properties, not the wording. For a hosted TENANT
    // the sentence must never name a host env var they cannot set, and must still say what they DO
    // get. It must also not promise future availability, which is the entire point of this state.
    const { get } = await runGate(UNPROVISIONABLE);
    const text = String(get("sec-master").nextElementSibling?.textContent ?? "");
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toMatch(/VIDEO_FINISH_URL|Set [A-Z_]+/);
    expect(text).toMatch(/clips/);
    expect(text, "this state must not promise the tier is coming").not.toMatch(/not yet/i);
  });
});
