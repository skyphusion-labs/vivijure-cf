import { describe, it, expect } from "vitest";
import {
  resolveCastImageMime,
  sniffCastImageMime,
  CAST_IMAGE_MIME_RE,
} from "../src/cast-media";

describe("cast image MIME allowlist + sniff (stored-XSS gate)", () => {
  it("CAST_IMAGE_MIME_RE rejects text/html and svg", () => {
    expect(CAST_IMAGE_MIME_RE.test("text/html")).toBe(false);
    expect(CAST_IMAGE_MIME_RE.test("image/svg+xml")).toBe(false);
    expect(CAST_IMAGE_MIME_RE.test("image/png")).toBe(true);
    expect(CAST_IMAGE_MIME_RE.test("image/jpeg")).toBe(true);
    expect(CAST_IMAGE_MIME_RE.test("image/jpg")).toBe(true);
    expect(CAST_IMAGE_MIME_RE.test("image/webp")).toBe(true);
  });

  it("resolveCastImageMime rejects text/html claims", () => {
    expect(() => resolveCastImageMime("text/html")).toThrow(/not allowed/);
  });

  it("resolveCastImageMime accepts png/jpeg/webp claims", () => {
    expect(resolveCastImageMime("image/png")).toBe("image/png");
    expect(resolveCastImageMime("image/jpg")).toBe("image/jpeg");
    expect(resolveCastImageMime("IMAGE/WEBP")).toBe("image/webp");
  });

  it("sniffCastImageMime reads magic bytes and returns null for HTML", () => {
    expect(sniffCastImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    expect(sniffCastImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffCastImageMime(new TextEncoder().encode("<html>"))).toBeNull();
  });

  it("resolveCastImageMime with bytes rejects HTML claiming image/png", () => {
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    expect(() => resolveCastImageMime("image/png", html)).toThrow(/recognizable/);
  });

  it("resolveCastImageMime with bytes rejects mime/content mismatch", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]);
    expect(() => resolveCastImageMime("image/jpeg", png)).toThrow(/does not match/);
  });
});
