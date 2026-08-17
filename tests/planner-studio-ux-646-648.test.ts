/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// cf#646 / #647 / #648: filmmaker-facing copy and chrome. These assertions
// read the shipped assets so a tidy-up that puts training, Unified Billing,
// or operator nav back on the happy path goes red.

const html = readFileSync("public/planner.html", "utf8");
const chrome = readFileSync("public/studio-chrome.js", "utf8");
const bundle = readFileSync("public/planner-bundle.js", "utf8");
const renderCfg = readFileSync("public/planner-render-config.js", "utf8");
const css = readFileSync("public/styles.css", "utf8");

describe("cf#648 cast is who is in the movie", () => {
  it("the cast step has an empty state and an add-character field", () => {
    expect(html).toMatch(/No saved characters yet/);
    expect(html).toMatch(/planner-faces-add/);
    expect(html).toMatch(/planner-faces-find/);
    expect(html).toMatch(/Who is in this movie/);
  });

  it("bundle happy-path copy says portraits are enough and does not push training", () => {
    const visible = html.replace(/<!--[\s\S]*?-->/g, "");
    expect(visible).not.toMatch(/8 or more/);
    expect(bundle).not.toMatch(/8 or more recommended/);
    expect(visible).toMatch(/A portrait per person is enough for a first film/);
    expect(visible).not.toMatch(/Open Cast to train/);
    expect(visible).not.toMatch(/LoRA training/);
    expect(visible).not.toMatch(/Make them consistent across shots/);
  });

  it("LoRA warning has a mount on the cast step, before bundle", () => {
    const facesIdx = html.indexOf('id="planner-faces"');
    const warnIdx = html.indexOf('id="planner-cast-lora-warning"');
    const bundleIdx = html.indexOf('id="planner-bundle"');
    expect(facesIdx).toBeGreaterThan(0);
    expect(warnIdx).toBeGreaterThan(facesIdx);
    expect(bundleIdx).toBeGreaterThan(warnIdx);
  });
});

describe("cf#646 render is three choices then spend", () => {
  it("motion is the default job and stills is a peer choice", () => {
    expect(html).toMatch(/id="planner-mode-stills"/);
    expect(html).toMatch(/id="planner-mode-motion"[^>]*checked/);
    expect(html).toMatch(/id="planner-keyframes-only"/);
    expect(html).not.toMatch(/id="planner-keyframes-only"[^>]*checked/);
  });

  it("scatter, module settings, and expert JSON live inside Advanced", () => {
    const advIdx = html.indexOf('id="planner-render-advanced"');
    expect(advIdx).toBeGreaterThan(0);
    expect(html.indexOf('id="planner-scatter"', advIdx)).toBeGreaterThan(advIdx);
    expect(html.indexOf('id="planner-module-config"', advIdx)).toBeGreaterThan(advIdx);
    expect(html.indexOf("expert: raw JSON", advIdx)).toBeGreaterThan(advIdx);
  });

  it("a spend sentence sits in front of the render button", () => {
    const spendIdx = html.indexOf('id="planner-render-spend"');
    const btnIdx = html.indexOf('id="planner-render-btn"');
    expect(spendIdx).toBeGreaterThan(0);
    expect(btnIdx).toBeGreaterThan(spendIdx);
  });

  it("planner copy never tells the filmmaker about Unified Billing", () => {
    expect(html).not.toMatch(/Unified Billing/);
    expect(renderCfg).toMatch(/filmmakerCostLine/);
    expect(renderCfg).toMatch(/Billed per render/);
  });
});

describe("cf#647 Modules and Settings leave primary nav", () => {
  it("default nav is Planner + Cast", () => {
    const block = chrome.slice(chrome.indexOf("const DEFAULT_NAV"), chrome.indexOf("const OPERATOR_NAV"));
    expect(block).toMatch(/planner/);
    expect(block).toMatch(/cast/);
    expect(block).not.toMatch(/Modules/);
    expect(block).not.toMatch(/Settings/);
  });

  it("operator pages stay reachable from the account menu", () => {
    expect(chrome).toMatch(/OPERATOR_NAV/);
    expect(chrome).toMatch(/data-studio-account-ops/);
    expect(chrome).toMatch(/modules/);
    expect(chrome).toMatch(/settings/);
  });
});

describe("filmmaker surface hides operator chrome", () => {
  it("account prefs expose Operator tools, keyed to localStorage", () => {
    expect(html).toMatch(/id="pref-operator-tools"/);
    expect(html).toMatch(/Operator tools/);
    expect(html).toMatch(/class="planner-body filmmaker-surface"/);
    expect(chrome).toMatch(/skyphusion\.planner\.operatorTools/);
    expect(chrome).toMatch(/filmmaker-surface/);
  });

  it("CSS hides the operator set under body.filmmaker-surface", () => {
    expect(css).toMatch(/body\.filmmaker-surface #planner-preflight-fold/);
    expect(css).toMatch(/body\.filmmaker-surface #planner-result/);
    expect(css).toMatch(/body\.filmmaker-surface #planner-markers-format/);
    expect(css).toMatch(/body\.filmmaker-surface #planner-markers-export/);
    expect(css).toMatch(/body\.filmmaker-surface #planner-bundle/);
    expect(css).toMatch(/body\.filmmaker-surface #planner-render-advanced/);
  });

  it("does not display:none the whole #planner-render section", () => {
    expect(css).not.toMatch(/body\.filmmaker-surface #planner-render\s*[,{]/);
  });

  it("title + credit cards stay outside the hidden Advanced fold", () => {
    const titlesIdx = html.indexOf("planner-film-titles");
    const advIdx = html.indexOf('id="planner-render-advanced"');
    expect(titlesIdx).toBeGreaterThan(0);
    expect(advIdx).toBeGreaterThan(titlesIdx);
  });

  it("auto-bundle helper is still present (hide, do not delete)", () => {
    expect(bundle).toMatch(/async function ensureFilmBundle/);
    expect(html).toMatch(/id="planner-bundle"/);
    expect(html).toMatch(/id="planner-bundle-btn"/);
  });
});
