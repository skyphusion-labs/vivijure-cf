/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import checks from "../public/hook-availability-checks.js";

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
const REASON = "Video finishing is not yet provisioned for this studio; finished renders deliver as per-shot clips.";

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
  const window: Record<string, unknown> = { hookAvailabilityChecks: checks };
  const payload = hooksUnavailable ? { host: { hooks_unavailable: hooksUnavailable } } : { host: {} };
  const fetchStub = async () => ({ ok: true, json: async () => payload });
  new Function("window", "document", "fetch", SRC)(window, document, fetchStub);
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
    for (const id of ["master-lufs", "master-format", "keyframe-steps", "music-prompt", "music-gen", "add-audio"]) {
      expect(get(id).disabled, id).toBe(false);
    }
    expect(doc.descendants().filter((e) => e.className.includes("note")).length).toBe(0);
  });
});
