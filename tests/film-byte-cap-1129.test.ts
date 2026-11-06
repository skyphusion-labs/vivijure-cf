import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { admitAssemble, assembleFilmByteCeiling } from "@skyphusion-labs/vivijure-core/assemble-admission";

// R2 documents 5 GiB less 5 MiB for one PUT, and every film leaves the container in one PUT (cf#1133).
const ONE_PUT_BYTES = 5_363_466_240;

// A 1080p film at 24 fps, measured, with every clip of known length.
function admit1080p(seconds: number) {
  return admitAssemble({
    clipCount: 1,
    width: 1920,
    height: 1080,
    fps: 24,
    basis: { seconds, measured: 1, planned: 0, unknown: 0 },
  });
}

// cf#1129. A film assemble admits must fit the routes that take a whole film afterwards.
describe("the video-finish film cap", () => {
  it("is what core's assemble admission allows, and that is one PUT", () => {
    const source = readFileSync(join(process.cwd(), "containers/video-finish/app.py"), "utf8");
    const m = /^MAX_FILM_BYTES = ([\d_]+)$/m.exec(source);
    expect(m).not.toBeNull();
    const cap = Number(m![1].replaceAll("_", ""));
    expect(cap).toBe(ONE_PUT_BYTES);
    expect(cap).toBe(assembleFilmByteCeiling());
  });
});

// cf#1133. Admission must never pass a film the container cannot upload in one PUT. The pinned core
// once allowed 6.85 GB from the disk budget alone, so a 1080p film of 64 to 82 minutes did all its
// work and then failed at upload. No min() here: a core that regresses to the disk ceiling goes red.
describe("assemble admission against one R2 PUT (cf#1133)", () => {
  it("never sets the ceiling above one PUT", () => {
    expect(assembleFilmByteCeiling()).toBeLessThanOrEqual(ONE_PUT_BYTES);
  });

  it("refuses a 70 minute 1080p film, which sits in the old gap", () => {
    const r = admit1080p(70 * 60);
    expect(r.predictedBytes).toBeGreaterThan(ONE_PUT_BYTES);
    expect(r.predictedBytes).toBeLessThan(6_852_516_352);
    expect(r.admitted).toBe(false);
    expect(r.reason).toContain("the most one upload carries");
  });

  it("admits a 60 minute 1080p film, so the refusal is about size and not about length alone", () => {
    const r = admit1080p(60 * 60);
    expect(r.predictedBytes).toBeLessThan(ONE_PUT_BYTES);
    expect(r.admitted).toBe(true);
    expect(r.ceilingBytes).toBeLessThanOrEqual(ONE_PUT_BYTES);
  });
});
