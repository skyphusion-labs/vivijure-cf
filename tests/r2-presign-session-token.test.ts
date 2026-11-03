import { describe, it, expect } from "vitest";
import { presignR2WithConfig, presignR2Get, type R2PresignConfig } from "../src/r2-presign";
import { presignR2Put as grokPresignPut } from "../modules/cf-grok-video/src/r2-put";
import type { Env } from "../src/env";

// vivijure-cf#1232: optional session token for R2 temporary credentials.
//
// Every expected URL and signature below was produced by botocore 1.35.99 (S3SigV4QueryAuth,
// service s3, region auto, clock pinned to 2026-06-16T12:00:00Z), an implementation independent of
// this repo. The two no-token URLs were ALSO captured from this repo's presigner before the change,
// and matched botocore byte for byte, which is what proves the reference agrees with us at all.

const cfg: R2PresignConfig = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "SECRETEXAMPLEKEY",
  endpoint: "https://acct123.r2.cloudflarestorage.com",
  bucket: "renders",
};
const FIXED = Date.UTC(2026, 5, 16, 12, 0, 0);
const TOKEN = "FQoGZXIvYXdzEXAMPLE/session+token==";
const TOKEN_ENC = "FQoGZXIvYXdzEXAMPLE%2Fsession%2Btoken%3D%3D";

const GOLDEN_GET =
  "https://acct123.r2.cloudflarestorage.com/renders/out.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20260616%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260616T120000Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Signature=2e2d5fd44b0507f63cdd6160cf16b7766826daf1346da96a271e4218298315ce";
const GOLDEN_PUT =
  "https://acct123.r2.cloudflarestorage.com/renders/renders/a%20b%23c.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20260616%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260616T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=db5396652bbf1bfa4c41a7af6cb37e6888bc49929dbd7d68b055790d58a808b8";
const BOTO_SIG_GET_TOKEN = "74bc4e1e9704795f1ef330ae30a5bebc0a81f25199893ef7e03cdc2a46ae71b9";
const BOTO_SIG_PUT_TOKEN = "ec6a5600d11149652748f4da0b208f486f87c90261bdea064b85f1e76bdf07e9";

describe("no session token: output is byte-identical to the long-lived-key form", () => {
  it("GET and PUT match the pre-change golden URLs exactly", async () => {
    expect(await presignR2WithConfig(cfg, "GET", "out.mp4", 300, FIXED)).toBe(GOLDEN_GET);
    expect(await presignR2WithConfig(cfg, "PUT", "renders/a b#c.mp4", 3600, FIXED)).toBe(GOLDEN_PUT);
  });

  it("an empty session token is treated as absent, not signed as a bare parameter", async () => {
    expect(await presignR2WithConfig({ ...cfg, sessionToken: "" }, "GET", "out.mp4", 300, FIXED)).toBe(GOLDEN_GET);
  });

  it("the cf-grok-video upload presigner matches the same golden PUT", async () => {
    const url = await grokPresignPut({ ...cfg, key: "renders/a b#c.mp4", expiresSeconds: 3600, nowMs: FIXED });
    expect(url).toBe(GOLDEN_PUT);
  });
});

describe("with a session token: known-answer vector from botocore", () => {
  it("GET signs X-Amz-Security-Token into the query and matches the reference signature", async () => {
    const url = await presignR2WithConfig({ ...cfg, sessionToken: TOKEN }, "GET", "out.mp4", 300, FIXED);
    expect(url).toBe(
      "https://acct123.r2.cloudflarestorage.com/renders/out.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20260616%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260616T120000Z&X-Amz-Expires=300&X-Amz-Security-Token=" +
        TOKEN_ENC +
        "&X-Amz-SignedHeaders=host&X-Amz-Signature=" +
        BOTO_SIG_GET_TOKEN,
    );
    expect(new URL(url).searchParams.get("X-Amz-Security-Token")).toBe(TOKEN);
  });

  it("PUT matches the reference signature", async () => {
    const url = await presignR2WithConfig({ ...cfg, sessionToken: TOKEN }, "PUT", "renders/a b#c.mp4", 3600, FIXED);
    expect(new URL(url).searchParams.get("X-Amz-Signature")).toBe(BOTO_SIG_PUT_TOKEN);
  });

  it("the cf-grok-video upload presigner matches the reference signature", async () => {
    const url = await grokPresignPut({ ...cfg, sessionToken: TOKEN, key: "renders/a b#c.mp4", expiresSeconds: 3600, nowMs: FIXED });
    expect(new URL(url).searchParams.get("X-Amz-Signature")).toBe(BOTO_SIG_PUT_TOKEN);
    expect(new URL(url).searchParams.get("X-Amz-Security-Token")).toBe(TOKEN);
  });
});

describe("env wiring", () => {
  const base = {
    R2_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
    R2_S3_SECRET_ACCESS_KEY: "SECRETEXAMPLEKEY",
    R2_S3_ENDPOINT: "https://acct123.r2.cloudflarestorage.com",
    R2_S3_BUCKET: "renders",
  };

  it("R2_S3_SESSION_TOKEN from env (plain string) reaches the signed URL", async () => {
    const url = await presignR2Get({ ...base, R2_S3_SESSION_TOKEN: TOKEN } as unknown as Env, "out.mp4");
    expect(new URL(url).searchParams.get("X-Amz-Security-Token")).toBe(TOKEN);
  });

  it("R2_S3_SESSION_TOKEN from a Secrets Store handle reaches the signed URL", async () => {
    const handle = { get: async () => TOKEN };
    const url = await presignR2Get({ ...base, R2_S3_SESSION_TOKEN: handle } as unknown as Env, "out.mp4");
    expect(new URL(url).searchParams.get("X-Amz-Security-Token")).toBe(TOKEN);
  });

  it("no R2_S3_SESSION_TOKEN in env means no X-Amz-Security-Token in the URL", async () => {
    const url = await presignR2Get(base as unknown as Env, "out.mp4");
    expect(url).not.toContain("X-Amz-Security-Token");
  });
});
