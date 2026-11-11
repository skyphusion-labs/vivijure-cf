import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { readCappedBytes, CappedReadError } from "../src/capped-body";
import { readProviderMedia, PROVIDER_IMAGE_MAX_BYTES } from "../modules/_shared/provider-media";

function makeEnv() {
  const puts: string[] = [];
  const env = {
    ALLOW_UNAUTHENTICATED: "true",
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    R2_RENDERS: {
      async put(key: string) { puts.push(key); },
      async get() { return null; },
      async head() { return null; },
    },
  } as unknown as Env;
  return { env, puts };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe("upload body cap", () => {
  it("refuses an oversized declared length before reading the body", async () => {
    const { env, puts } = makeEnv();
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const res = await worker.fetch(new Request("https://studio.example/api/upload", {
      method: "POST",
      headers: { "content-type": "image/png", "content-length": String(26 * 1024 * 1024) },
      body,
      duplex: "half",
    } as RequestInit), env, ctx);
    expect(res.status).toBe(413);
    expect(puts).toEqual([]);
    const msg = await res.json() as { error: string };
    expect(msg.error).toMatch(/Content-Length/);
  });

  it("refuses an oversized body that declares no length, and stops reading", async () => {
    const { env, puts } = makeEnv();
    let pulls = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 40) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const res = await worker.fetch(new Request("https://studio.example/api/upload", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body,
      duplex: "half",
    } as RequestInit), env, ctx);
    expect(res.headers.get("content-length") === null || res.status === 413).toBe(true);
    expect(res.status).toBe(413);
    expect(pulls).toBeLessThan(40);
    expect(puts).toEqual([]);
  });
});

describe("route parameter decoding", () => {
  it("returns 400 with the normal security headers for a bad percent-escape", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request("https://studio.example/api/cast/%E0%A4%A"), env, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad request path");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
  });
});

describe("audio analyze key space", () => {
  it("refuses a key outside served artifact space and does not write a marker", async () => {
    const { env, puts } = makeEnv();
    const res = await worker.fetch(new Request("https://studio.example/api/audio/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audioKey: "quarantine/2026/hold/audio/a.mp3" }),
    }), env, ctx);
    expect(res.status).toBe(400);
    expect(puts).toEqual([]);
  });
});

describe("capped body reader", () => {
  it("refuses a declared length without reading", async () => {
    let read = false;
    const headers = new Headers({ "content-length": "100" });
    const bodyStream = { getReader() { read = true; throw new Error("read"); } } as unknown as ReadableStream<Uint8Array>;
    await expect(readCappedBytes(headers, bodyStream, async () => new ArrayBuffer(0), 10)).rejects.toBeInstanceOf(CappedReadError);
    expect(read).toBe(false);
  });
});

describe("provider media", () => {
  it("stops an oversized download and does not keep a disallowed type", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(8));
        if (pulls > 5) controller.close();
      },
    });
    const resp = new Response(body, { headers: { "content-type": "text/html" } });
    await expect(readProviderMedia(resp, { maxBytes: 10, fallbackType: "image/png" })).rejects.toThrow();
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("stores a sniffed type instead of a mismatched header", async () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const resp = new Response(webp, { headers: { "content-type": "image/png" } });
    const got = await readProviderMedia(resp, { maxBytes: PROVIDER_IMAGE_MAX_BYTES, fallbackType: "image/png" });
    expect(got.contentType).toBe("image/webp");
  });

  it("refuses a declared length over the cap", async () => {
    const resp = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png", "content-length": String(PROVIDER_IMAGE_MAX_BYTES + 1) },
    });
    await expect(readProviderMedia(resp, { maxBytes: PROVIDER_IMAGE_MAX_BYTES, fallbackType: "image/png" })).rejects.toThrow(/Content-Length/);
  });
});
