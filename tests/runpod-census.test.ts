import { describe, it, expect } from "vitest";
import { stripComments, reachesRunpod } from "./runpod-census";

describe("cf#951: the RunPod classifier reads runtime code, not prose", () => {
  it("does NOT enrol a module that only CITES the helper in a comment", () => {
    const src = `
      // Branch is BOUND-ness, never failover -- the same rule as modules/_shared/runpod-route.ts.
      import { falThing } from "./fal";
      export const x = 1;
    `;
    expect(reachesRunpod(src)).toBe(false);
  });

  it("does NOT enrol a module that names the host in a block comment", () => {
    const src = `/* seedance submits to https://api.runpod.ai/v2/<id>/run; we do not. */ export const y = 2;`;
    expect(reachesRunpod(src)).toBe(false);
  });

  it("STILL enrols a module that imports the helper", () => {
    const src = `import { runpodRoute } from "../../_shared/runpod-route";\nexport const z = 3;`;
    expect(reachesRunpod(src)).toBe(true);
  });

  it("STILL enrols a module that names the host in runtime code", () => {
    const src = `const endpoint = "https://api.runpod.ai/v2/" + MODEL;`;
    expect(reachesRunpod(src)).toBe(true);
  });

  // THE SHARP ONE. The host contains `//`. A naive line-comment stripper eats the rest of the line
  // and the host half of the predicate silently goes to zero -- which is exactly the failure this
  // suite already survived once when cf#394 moved the base URL out of the modules.
  it("does not mistake the // inside a URL STRING for a comment", () => {
    expect(stripComments(`const u = "https://api.runpod.ai/v2/x"; // trailing comment`))
      .toContain("https://api.runpod.ai/v2/x");
    expect(stripComments(`const u = "https://api.runpod.ai/v2/x"; // trailing comment`))
      .not.toContain("trailing comment");
  });

  it("handles single quotes, backticks and escapes without losing the host", () => {
    expect(reachesRunpod(`const u = 'https://api.runpod.ai/v2/x';`)).toBe(true);
    expect(reachesRunpod("const u = `https://api.runpod.ai/v2/${id}`;")).toBe(true);
    expect(reachesRunpod(`const u = "a\\"b https://api.runpod.ai/v2/x";`)).toBe(true);
  });

  it("strips a comment that sits after code on the same line, keeping the code", () => {
    const src = `import { a } from "../../_shared/runpod-route"; // cited\nconst q = 1;`;
    expect(reachesRunpod(src)).toBe(true);
    expect(stripComments(src)).not.toContain("cited");
  });
});
