import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleFilmByteCeiling } from "@skyphusion-labs/vivijure-core/assemble-admission";

// R2 documents 5 GiB less 5 MiB for one PUT, and every film leaves the container in one PUT (cf#1133).
const ONE_PUT_BYTES = 5_363_466_240;

// cf#1129. A film assemble admits must fit the routes that take a whole film afterwards.
describe("the video-finish film cap", () => {
  it("is what core's assemble admission allows", () => {
    const source = readFileSync(join(process.cwd(), "containers/video-finish/app.py"), "utf8");
    const m = /^MAX_FILM_BYTES = ([\d_]+)$/m.exec(source);
    expect(m).not.toBeNull();
    // min() because a core with the old 6.85 GB ceiling may still be pinned. The cap never follows it past one PUT.
    expect(Number(m![1].replaceAll("_", ""))).toBe(Math.min(assembleFilmByteCeiling(), ONE_PUT_BYTES));
  });
});
