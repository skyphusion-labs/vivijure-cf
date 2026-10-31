import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleFilmByteCeiling } from "@skyphusion-labs/vivijure-core/assemble-admission";

// cf#1129. A film assemble admits must fit the routes that take a whole film afterwards.
describe("the video-finish film cap", () => {
  it("is what core's assemble admission allows", () => {
    const source = readFileSync(join(process.cwd(), "containers/video-finish/app.py"), "utf8");
    const m = /^MAX_FILM_BYTES = ([\d_]+)$/m.exec(source);
    expect(m).not.toBeNull();
    expect(Number(m![1].replaceAll("_", ""))).toBe(assembleFilmByteCeiling());
  });
});
