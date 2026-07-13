import { describe, it, expect } from "vitest";
import { emitTar, readTar } from "@skyphusion-labs/vivijure-core/tar";

const enc = new TextEncoder();
const BLOCK = 512;

describe("vivijure-core/tar (USTAR) round-trip", () => {
  it("round-trips a set of files byte-for-byte", () => {
    const files = [
      { name: "manifest.json", content: enc.encode('{"hello":"world"}') },
      { name: "assets/portrait.png", content: new Uint8Array([1, 2, 3, 4, 5]) },
      { name: "assets/lora.safetensors", content: new Uint8Array(1000).fill(7) },
    ];
    const tar = emitTar(files);
    const parsed = readTar(tar);
    expect(parsed.map((f) => f.name)).toEqual(files.map((f) => f.name));
    parsed.forEach((f, i) => {
      expect(Array.from(f.content)).toEqual(Array.from(files[i].content));
    });
  });

  it("pads every entry + the archive to 512-byte block boundaries", () => {
    const tar = emitTar([{ name: "a.bin", content: new Uint8Array([9]) }]);
    expect(tar.length % BLOCK).toBe(0);
    expect(tar.length).toBe(BLOCK + BLOCK + BLOCK * 2);
  });

  it("an empty-file entry survives the round-trip", () => {
    const parsed = readTar(emitTar([{ name: "empty", content: new Uint8Array(0) }]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].content).toHaveLength(0);
  });

  it("rejects an entry name longer than 100 bytes (loud, no PAX fallback)", () => {
    expect(() => emitTar([{ name: "a/".repeat(60), content: new Uint8Array(0) }])).toThrow(/too long/);
  });

  it("stops cleanly at the end-of-archive zero blocks", () => {
    const tar = emitTar([{ name: "only", content: enc.encode("hi") }]);
    const withTrailer = new Uint8Array(tar.length + BLOCK);
    withTrailer.set(tar, 0);
    withTrailer.set(enc.encode("junk-not-a-real-header"), tar.length);
    expect(readTar(withTrailer).map((f) => f.name)).toEqual(["only"]);
  });
});
