import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as viaShared from "../modules/_shared/log-scrub";
import * as viaHost from "../src/log-scrub";

// cf#223 follow-up. Two separate jobs, both of them assertions about an ABSENCE, which is why they
// have to be written down on purpose: nothing notices an absence decaying.
//
// 1. modules/_shared/log-scrub.ts is a POINTER at src/log-scrub.ts, not a second implementation.
//    The reason that matters here is not tidiness. src/providers/openai-image.ts WAS a second
//    implementation of the OpenAI image call: cf#223 hardened it, nothing imported it, and the live
//    copy one directory away kept leaking for as long as the patched copy existed to look at. A
//    copied helper forks at copy time and the weakest copy guards the least-watched path.
//
// 2. No module may interpolate a RESPONSE BODY into a thrown Error. That is the defect class itself,
//    and the three behavioural tests in tests/log-scrub.test.ts cover the three sites that existed
//    when it was found. This one covers the sites that do not exist yet.

const ROOT = join(import.meta.dirname, "..");
const sharedPath = join(ROOT, "modules", "_shared", "log-scrub.ts");

describe("modules/_shared/log-scrub re-exports the host vocabulary and adds nothing", () => {
  it("exposes the SAME export names as src/log-scrub, derived from both sides", () => {
    const shared = Object.keys(viaShared).sort();
    const host = Object.keys(viaHost).sort();
    expect(shared.length, "floor: two empty namespaces are trivially equal").toBeGreaterThan(0);
    expect(shared).toEqual(host);
  });

  it("re-exports the SAME functions, not lookalikes", () => {
    // Identity, not shape. A local re-implementation with a matching surface is precisely the
    // duplicate this file exists to prevent, and it would pass a name-only comparison.
    expect(viaShared.untrustedLabel).toBe(viaHost.untrustedLabel);
    expect(viaShared.keyLabel).toBe(viaHost.keyLabel);
    expect(viaShared.shortId).toBe(viaHost.shortId);
  });

  it("declares nothing of its own", () => {
    // The durable half. If somebody adds a `function` here rather than to src/log-scrub.ts, the
    // fork is back and the two identity assertions above still pass for every symbol that happens
    // to line up.
    const src = readFileSync(sharedPath, "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "a declaration reappeared in the pointer file").not.toMatch(
      /\b(function|const|let|var|class|interface|type)\s/,
    );
    expect(code, "the re-export itself is gone").toContain('export * from "../../src/log-scrub"');
  });
});

/** Every .ts under modules/, recursively. */
function moduleSources(dir = join(ROOT, "modules")): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...moduleSources(p));
    else if (e.name.endsWith(".ts")) out.push({ rel: p.slice(ROOT.length + 1), src: readFileSync(p, "utf8") });
  }
  return out;
}

describe("no module interpolates a response BODY into a thrown Error (cf#223)", () => {
  const FILES = moduleSources();

  // File-scoped dataflow, and I am naming the limit rather than implying a proof: this finds an
  // identifier that is assigned from `.json()`/`.text()` ANYWHERE in the same file and also appears
  // inside a `throw new Error(`...`)` template in that file. It does not follow a body across a
  // function boundary or through a helper's return value, so it is a RATCHET over the shape that
  // has actually occurred three times, not a guarantee. The behavioural tests are the real gate.
  // The optional `\(` matters: the shape in this tree is `const e = (await resp.json()) as {...}`,
  // with the paren wrapping the await for the type assertion. My first version required the paren
  // to come BEFORE `await` and therefore matched nothing at all -- caught by the positive control
  // below, which is the only reason this regex is right rather than reassuring.
  const BODY_READ = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*await\s+[\w.$]+\.(?:json|text)\(\)/g;
  const THROWN = /throw new Error\(`([^`]*)`\)/g;

  it("read the tree (positive control)", () => {
    // Every assertion below is shaped so that reading NOTHING would find no offenders and pass.
    expect(FILES.length, "no module .ts files were read").toBeGreaterThan(50);
    expect(FILES.some((f) => f.rel.includes("image-generate"))).toBe(true);
    expect(FILES.some((f) => f.rel.includes("plan-enhance"))).toBe(true);
    // The matchers must be able to fire at all.
    const anyBodyRead = FILES.filter((f) => [...f.src.matchAll(BODY_READ)].length > 0);
    expect(anyBodyRead.length, "the body-read matcher found nothing anywhere").toBeGreaterThan(0);
    const anyThrow = FILES.filter((f) => [...f.src.matchAll(THROWN)].length > 0);
    expect(anyThrow.length, "the interpolating-throw matcher found nothing anywhere").toBeGreaterThan(0);
  });

  it("no body-derived identifier reaches a thrown template", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      const bodyVars = new Set([...src.matchAll(BODY_READ)].map((m) => m[1]));
      if (!bodyVars.size) continue;
      for (const t of src.matchAll(THROWN)) {
        for (const interp of t[1].matchAll(/\$\{\s*([A-Za-z_$][\w$]*)/g)) {
          if (bodyVars.has(interp[1])) offenders.push(`${rel}: \`${t[1]}\` interpolates body-derived \`${interp[1]}\``);
        }
      }
    }
    expect(offenders, "a response body reaches a thrown Error message").toEqual([]);
  });
});
