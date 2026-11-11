// cf#964: a non-empty VIDEO_FINISH_URL is not proof the video-finish tier is there.
//
// BOTH DIRECTIONS, per cf#98: an unusable value must report the tier absent, and a usable one must
// still report it present, or the fix greys out a working self-host that reaches its container by URL.

import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { studioEnv } from "../src/orchestrator-env";
import type { Env } from "../src/env";
import {
  VIDEO_FINISH_CAPABILITY_KEY,
  usableVideoFinishUrl,
  videoFinishState,
} from "../src/video-finish-availability";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const UNUSABLE = [
  "${VIDEO_FINISH_URL}",
  "https://${VIDEO_FINISH_HOST}",
  "video-finish.example",
  "not a url",
  "ftp://video-finish.example",
  "file:///etc/hosts",
  "   ",
  "",
];
const USABLE = ["https://video-finish.example", "http://localhost:8080", " https://video-finish.example/ "];

describe("usableVideoFinishUrl (cf#964)", () => {
  for (const v of UNUSABLE) {
    it(`refuses ${JSON.stringify(v)}`, () => {
      expect(usableVideoFinishUrl(v)).toBeUndefined();
    });
  }
  for (const v of USABLE) {
    it(`keeps ${JSON.stringify(v)}`, () => {
      expect(usableVideoFinishUrl(v)).toBe(v.trim());
    });
  }
  it("refuses a value that is not a string", () => {
    expect(usableVideoFinishUrl(undefined)).toBeUndefined();
    expect(usableVideoFinishUrl(42)).toBeUndefined();
  });
});

describe("videoFinishState on the URL path (cf#964)", () => {
  it("an unrendered placeholder is not available", () => {
    expect(videoFinishState({ VIDEO_FINISH_URL: "${VIDEO_FINISH_URL}" })).toBe("provisionable");
  });
  it("a bare word is not available", () => {
    expect(videoFinishState({ VIDEO_FINISH_URL: "video-finish" })).toBe("provisionable");
  });
  it("an unusable URL still honours an unprovisionable declaration", () => {
    expect(
      videoFinishState({ VIDEO_FINISH_URL: "${VIDEO_FINISH_URL}", VIDEO_FINISH_TIER_STATE: "unprovisionable" } as never),
    ).toBe("unprovisionable");
  });
  it("a usable URL is available (the self-host path keeps working)", () => {
    expect(videoFinishState({ VIDEO_FINISH_URL: "https://video-finish.example" })).toBe("available");
  });
});

describe("studioEnv hands core no unusable VIDEO_FINISH_URL (cf#964)", () => {
  it("clears a placeholder, so core takes the degrade path", () => {
    const e = studioEnv({ VIDEO_FINISH_URL: "${VIDEO_FINISH_URL}" } as Env);
    expect(e.VIDEO_FINISH_URL).toBeUndefined();
  });
  it("keeps a usable URL", () => {
    const e = studioEnv({ VIDEO_FINISH_URL: "https://video-finish.example" } as Env);
    expect(e.VIDEO_FINISH_URL).toBe("https://video-finish.example");
  });
});

describe("the panel sees the tier absent behind a placeholder (cf#964)", () => {
  async function hooks(url: string): Promise<Record<string, string> | undefined> {
    const e = {
      ALLOW_UNAUTHENTICATED: "true",
      ASSETS: { fetch: async () => new Response("asset") },
      VIDEO_FINISH_URL: url,
    } as unknown as Parameters<typeof worker.fetch>[1];
    const res = await worker.fetch(new Request("https://studio.example/api/modules"), e, ctx);
    const body = (await res.json()) as { host?: { hooks_unavailable?: Record<string, string> } };
    return body.host?.hooks_unavailable;
  }
  it("a placeholder reports capability:video-finish unavailable", async () => {
    expect((await hooks("${VIDEO_FINISH_URL}"))?.[VIDEO_FINISH_CAPABILITY_KEY]).toBeDefined();
  });
  it("a usable URL reports nothing", async () => {
    expect((await hooks("https://video-finish.example"))?.[VIDEO_FINISH_CAPABILITY_KEY]).toBeUndefined();
  });
});
