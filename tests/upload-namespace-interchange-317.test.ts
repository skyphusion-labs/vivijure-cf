import { describe, it, expect } from "vitest";
import { assembleBundle } from "@skyphusion-labs/vivijure-core/bundle-assembler";

// cf#317 -- is a key from POST /api/upload usable where the panel uses a key from
// POST /api/storyboard/character-ref?
//
// The two routes are the same handler logic differing ONLY in the key prefix they write under
// (`uploads/` vs `character-refs/`), and the bundle assembler resolves a training image with a plain
// R2 get on whatever key it is handed. If that is true end to end, `upload_image` already covers the
// character-ref route and a third upload tool would be surface for nothing.
//
// "If that is true" is the part worth proving rather than reading, so this drives the REAL
// assembleBundle. The instrument is the bundle key itself: it is CONTENT-ADDRESSED
// (tests/bundle-key-collision.test.ts locks that), so two runs producing the SAME key is proof the
// two tarballs are byte-identical, and the prefix provably never reaches the artifact.

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);
const OTHER_PNG = new Uint8Array([...PNG.slice(0, 20), 0x00, 0x00, 0x00, 0x02]);

/** An R2 stub that ONLY knows the keys it was given, so a miss is a real miss. */
function envWith(objects: Record<string, Uint8Array>) {
  const puts: string[] = [];
  return {
    puts,
    env: {
      R2_RENDERS: {
        get: async (key: string) =>
          objects[key]
            ? {
                arrayBuffer: async () => objects[key].buffer.slice(
                  objects[key].byteOffset,
                  objects[key].byteOffset + objects[key].byteLength,
                ),
                httpMetadata: { contentType: "image/png" },
              }
            : null,
        put: async (key: string) => {
          puts.push(key);
          return undefined;
        },
      },
    } as never,
  };
}

const storyboard = {
  title: "Interchange Test",
  projectName: "interchange_test",
  full_prompt: "a character stands in a corridor",
  style_prefix: "",
  style_category: "None",
  style_preset: "None",
  use_characters: ["A"],
  cast_rules: "",
  scenes: [{ id: "shot_01", prompt: "A stands in a corridor", character_slots: ["A"] }],
};

const refsWith = (key: string) => ({
  A: { name: "Ada", prompt: "a tall woman in a grey coat", trainingImages: [{ key }] },
});

async function bundleWith(key: string, objects: Record<string, Uint8Array>) {
  const { env } = envWith(objects);
  return assembleBundle(env, { storyboard, characterRefs: refsWith(key) } as never);
}

describe("cf#317 uploads/ and character-refs/ are interchangeable at the bundle boundary", () => {
  // PREDICTIONS, stated before the run:
  //   A  character-refs/ key -> ok, some bundle key           (positive control)
  //   B  uploads/ key, SAME bytes -> ok, the SAME bundle key  (UNDER TEST)
  //   C  a key in neither namespace, absent from R2 -> NOT ok (fixed under every hypothesis)
  //   D  uploads/ key, DIFFERENT bytes -> a DIFFERENT key     (negative control on the instrument)

  it("row A (positive control): a character-refs/ key assembles", async () => {
    const r = await bundleWith("character-refs/a.png", { "character-refs/a.png": PNG });
    expect(r.ok, `errors: ${JSON.stringify((r as { errors?: string[] }).errors)}`).toBe(true);
    expect((r as { bundleKey: string }).bundleKey).toMatch(/^bundles\/.+\.tar\.gz$/);
  });

  it("row B (under test): an uploads/ key with the same bytes yields the SAME bundle key", async () => {
    const a = await bundleWith("character-refs/a.png", { "character-refs/a.png": PNG });
    const b = await bundleWith("uploads/deadbeef.png", { "uploads/deadbeef.png": PNG });
    expect(b.ok).toBe(true);
    // The bundle key is content-addressed, so equal keys means byte-identical tarballs: the prefix
    // does not reach the artifact in ANY form, not the registry, not a path inside the tar.
    expect((b as { bundleKey: string }).bundleKey).toBe((a as { bundleKey: string }).bundleKey);
  });

  it("row C (fixed under every hypothesis): a key absent from R2 fails", async () => {
    // If this passed, the R2 stub would be returning bytes for any key and rows A/B would be
    // meaningless. It is the row whose answer no hypothesis about the prefix can change.
    const r = await bundleWith("uploads/missing.png", { "uploads/other.png": PNG });
    expect(r.ok).toBe(false);
    expect(JSON.stringify((r as { errors: string[] }).errors)).toMatch(/not found/i);
  });

  it("row D (negative control): different bytes yield a DIFFERENT bundle key", async () => {
    // Proves row B's equality is a real signal and not a constant: the instrument can distinguish.
    const a = await bundleWith("uploads/a.png", { "uploads/a.png": PNG });
    const b = await bundleWith("uploads/a.png", { "uploads/a.png": OTHER_PNG });
    expect((b as { bundleKey: string }).bundleKey).not.toBe((a as { bundleKey: string }).bundleKey);
  });

  it("row E: the same holds when image-prep SUCCEEDS, not only when it degrades", async () => {
    // The first run of this file degraded through image-prep (no presign in the stub), so that
    // branch was never exercised and the rows above could not have seen a prefix leaking through
    // it. Closing that rather than footnoting it: pre-populate the byte-derived cache key so
    // prepPortraitBytes takes its CACHE-HIT path and returns cleaned bytes for real.
    const digest = await crypto.subtle.digest("SHA-256", PNG);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const cleanKey = `cast-clean/${hash}.png`;
    const CLEANED = new Uint8Array([...PNG, 0xaa, 0xbb]);

    const a = await bundleWith("character-refs/a.png", {
      "character-refs/a.png": PNG,
      [cleanKey]: CLEANED,
    });
    const b = await bundleWith("uploads/deadbeef.png", {
      "uploads/deadbeef.png": PNG,
      [cleanKey]: CLEANED,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect((b as { bundleKey: string }).bundleKey).toBe((a as { bundleKey: string }).bundleKey);

    // POSITIVE CONTROL that the cache branch was actually taken: cleaned bytes differ from the
    // original, so a bundle built WITH the cache must differ from one built without it. If these
    // were equal, image-prep degraded again and this row proved nothing.
    const degraded = await bundleWith("uploads/deadbeef.png", { "uploads/deadbeef.png": PNG });
    expect((b as { bundleKey: string }).bundleKey).not.toBe(
      (degraded as { bundleKey: string }).bundleKey,
    );
  });

  it("the assembler is handed the key VERBATIM, with no prefix rewriting", async () => {
    // A rewrite would make row B pass for the wrong reason (both resolving to one canonical key).
    const seen: string[] = [];
    const env = {
      R2_RENDERS: {
        get: async (key: string) => {
          seen.push(key);
          return {
            arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
            httpMetadata: { contentType: "image/png" },
          };
        },
        put: async () => undefined,
      },
    } as never;
    await assembleBundle(env, {
      storyboard,
      characterRefs: refsWith("uploads/verbatim-check.png"),
    } as never);
    expect(seen).toContain("uploads/verbatim-check.png");
  });
});
