import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchInstallManifestText,
  InstallManifestError,
  MANIFEST_READ_ATTEMPTS,
} from "../src/install-manifest-fetch";

/** A fetcher that yields `outcomes` in order. Each outcome is a status number (-> Response) or the
 *  string "throw" (-> rejected fetch, like a network/timeout). Counts the calls and captures init. */
function sequencedModule(outcomes: Array<number | "throw">, body = '{"name":"x"}') {
  let i = 0;
  const calls = { n: 0, inits: [] as Array<RequestInit | undefined> };
  const fetcher = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const outcome = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      calls.n += 1;
      calls.inits.push(init);
      if (outcome === "throw") throw new Error("network timeout");
      return new Response(body, {
        status: outcome,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { fetcher, calls };
}

describe("fetchInstallManifestText (cf#600)", () => {
  it("passes an AbortSignal (the per-read timeout) on the manifest fetch", async () => {
    const { fetcher, calls } = sequencedModule([200]);
    await fetchInstallManifestText(fetcher);
    expect(calls.inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the RAW text, not a re-serialized object", async () => {
    const raw = '{"name":"x","hooks":["finish"]}';
    const { fetcher } = sequencedModule([200], raw);
    expect(await fetchInstallManifestText(fetcher)).toBe(raw);
  });

  it("retries a transient 503 then succeeds", async () => {
    const { fetcher, calls } = sequencedModule([503, 200], '{"ok":true}');
    expect(await fetchInstallManifestText(fetcher)).toBe('{"ok":true}');
    expect(calls.n).toBe(2);
  });

  it("retries a thrown fetch (network/timeout) then succeeds", async () => {
    const { fetcher, calls } = sequencedModule(["throw", 200], '{"ok":true}');
    expect(await fetchInstallManifestText(fetcher)).toBe('{"ok":true}');
    expect(calls.n).toBe(2);
  });

  it("gives up after bounded attempts on a persistent transient error", async () => {
    const { fetcher, calls } = sequencedModule([503, 503, 503, 503]);
    await expect(fetchInstallManifestText(fetcher)).rejects.toBeInstanceOf(InstallManifestError);
    expect(calls.n).toBe(MANIFEST_READ_ATTEMPTS);
  });

  it("does NOT retry a 4xx (real, stable error)", async () => {
    const { fetcher, calls } = sequencedModule([404, 200]);
    await expect(fetchInstallManifestText(fetcher)).rejects.toMatchObject({
      name: "InstallManifestError",
      message: "GET /module.json -> 404",
      status: 404,
    });
    expect(calls.n).toBe(1);
  });
});

describe("hInstallModule wiring (cf#600)", () => {
  it("the install handler calls fetchInstallManifestText, not a bare fetcher.fetch", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
    expect(src, "install path no longer imports the helper").toContain("fetchInstallManifestText");
    // A bare fetch of the same URL is the defect: no timeout, no retry.
    expect(src).not.toMatch(/fetcher\.fetch\(\s*["']https:\/\/module\/module\.json["']\s*\)/);
  });
});
