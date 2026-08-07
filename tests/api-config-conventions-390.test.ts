// cf#390 -- four config-passing conventions across the studio API; wrong shape fails SILENTLY.
//
// This is a DRIFT GUARD, not a rewrite. The four shapes are documented in
// docs/api-config-conventions.md. Each assertion below pins a call site so a silent shape change
// (e.g. flipping deep: false -> true, or renaming audio/analyze fields to nested config) fails CI
// and forces the docs to update with the code. Full door unification is out of scope.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const DOC = "docs/api-config-conventions.md";
const INDEX = "src/index.ts";
const SCORE_BED = "src/score-bed.ts";

function src(path: string): string {
  return readFileSync(path, "utf8");
}

describe("cf#390: config-passing conventions are documented and pinned", () => {
  it("the convention doc exists and names all four surfaces", () => {
    expect(existsSync(DOC), `${DOC} missing`).toBe(true);
    const d = src(DOC);
    expect(d).toContain("keyframe_config");
    expect(d).toContain("motion_config");
    expect(d).toContain("finish_config");
    expect(d).toContain("film_finish_config");
    expect(d).toContain("/api/storyboard/score-bed");
    expect(d).toContain("/api/audio/analyze");
    expect(d).toContain("clipSeconds");
    expect(d).toContain("deep: false");
    expect(d).toContain("deep: true");
  });

  // Shape A + B: hStartFilm configMaps -- flat for keyframe/motion, nested for the four chain maps.
  it("submit_film / hStartFilm pins FLAT keyframe+motion and NESTED finish/speech/film_finish/master", () => {
    const index = src(INDEX);
    // Narrow to the hStartFilm handler block so we do not match renderOverrides elsewhere.
    const start = index.indexOf("const hStartFilm:");
    expect(start, "hStartFilm handler missing").toBeGreaterThanOrEqual(0);
    // Next top-level const handler after hStartFilm (any name).
    const rest = index.slice(start);
    const nextHandler = rest.search(/\nconst h[A-Z][A-Za-z]+: Handler/);
    const block = nextHandler > 0 ? rest.slice(0, nextHandler) : rest.slice(0, 4000);

    expect(block).toMatch(/\{\s*label:\s*"keyframe_config"[\s\S]*?deep:\s*false\s*\}/);
    expect(block).toMatch(/\{\s*label:\s*"motion_config"[\s\S]*?deep:\s*false\s*\}/);
    expect(block).toMatch(/\{\s*label:\s*"finish_config"[\s\S]*?deep:\s*true\s*\}/);
    expect(block).toMatch(/\{\s*label:\s*"speech_config"[\s\S]*?deep:\s*true\s*\}/);
    expect(block).toMatch(/\{\s*label:\s*"film_finish_config"[\s\S]*?deep:\s*true\s*\}/);
    expect(block).toMatch(/\{\s*label:\s*"master_config"[\s\S]*?deep:\s*true\s*\}/);
  });

  // Shape C: score-bed takes a nested `config` object on the body.
  it("score-bed handler reads nested body.config and forwards it", () => {
    const index = src(INDEX);
    const start = index.indexOf("const hScoreBedGenerate:");
    expect(start, "hScoreBedGenerate missing").toBeGreaterThanOrEqual(0);
    const rest = index.slice(start);
    const nextHandler = rest.search(/\nconst h[A-Z][A-Za-z]+: Handler/);
    const block = nextHandler > 0 ? rest.slice(0, nextHandler) : rest.slice(0, 2500);

    // Type of the body includes config?: Record...
    expect(block).toMatch(/config\?:\s*Record<string,\s*unknown>/);
    // Forwarded into startScoreBedGenerate
    expect(block).toMatch(/config:\s*a\.config/);
    // score-bed.ts still validates that bag against the module schema
    const score = src(SCORE_BED);
    expect(score).toMatch(/args\.config/);
    expect(score).toMatch(/validateConfig\(/);
  });

  // Shape D: audio/analyze is top-level camelCase, not a nested config object.
  it("audio/analyze uses top-level camelCase AudioAnalyzeRequest fields (no nested config)", () => {
    const index = src(INDEX);
    const start = index.indexOf("const hAudioAnalyze:");
    expect(start, "hAudioAnalyze missing").toBeGreaterThanOrEqual(0);
    const rest = index.slice(start);
    const nextHandler = rest.search(/\nconst h[A-Z][A-Za-z]+: Handler/);
    const block = nextHandler > 0 ? rest.slice(0, nextHandler) : rest.slice(0, 800);

    expect(block).toMatch(/AudioAnalyzeRequest/);
    expect(block).toMatch(/analyzeAudioBeats\(/);
    // Must pass the body object itself (top-level fields), not a.config.
    expect(block).toMatch(/analyzeAudioBeats\(\s*env,\s*a\s*,/);
    // Must NOT introduce a nested config envelope on this door.
    expect(block).not.toMatch(/config:\s*a\.config/);
    // CONTRACT table documents the camelCase names the client must send.
    const contract = src("docs/CONTRACT.md");
    const analyzeSec = contract.indexOf("### 2.17 POST /api/audio/analyze");
    expect(analyzeSec, "CONTRACT §2.17 missing").toBeGreaterThanOrEqual(0);
    const section = contract.slice(analyzeSec, analyzeSec + 1200);
    expect(section).toContain("clipSeconds");
    expect(section).toContain("forceShots");
    expect(section).toContain("audioKey");
    // Snake_case at the HTTP boundary is the #390 footgun -- must not be documented as the client shape.
    expect(section).not.toMatch(/\| `clip_seconds`/);
    expect(section).not.toMatch(/\| `force_shots`/);
  });

  it("CLAUDE.md docs map points at the convention page", () => {
    const claude = src("CLAUDE.md");
    expect(claude).toMatch(/api-config-conventions\.md/);
  });
});
