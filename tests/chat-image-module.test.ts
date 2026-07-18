// POST /api/chat image path after cf#129 phase 2: module-dispatched, artifact written to the bucket
// that /api/artifact SERVES.
//
// The cf#140 assertion here FETCHES THE ARTIFACT BACK over the real serve route. That defect was
// never a failed write -- the object existed, in a bucket the serve route does not read -- so an
// assertion that inspected the write would have gone green on the broken code. Only a read-back
// catches this class.

import { describe, it, expect, beforeEach } from "vitest";
import { MODULE_API, type RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import worker from "../src/index";
import type { Env } from "../src/env";

// 1x1 PNG, so this asserts on real image bytes rather than a placeholder string.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const IMAGE_MODEL_IDS = ["acme/img-xl", "acme/img-mini"];

// Deliberately NOT named "image-generate": a fixture borrowing the first-party name would hide any
// name special-casing in the projection or dispatch.
const imager: RegisteredModule = {
  name: "acme-imagegen",
  version: "1.0.0",
  api: MODULE_API,
  hooks: ["image.generate"],
  provides: [{ id: "acme-img", label: "ACME Image" }],
  binding: "MODULE_ACMEIMAGEGEN",
  config_schema: {
    model: { type: "enum", values: IMAGE_MODEL_IDS, default: IMAGE_MODEL_IDS[0], label: "image model" },
  },
};

function imageModuleWorker(opts: { fail?: string; pending?: boolean; empty?: boolean } = {}) {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/module.json") {
        return new Response(JSON.stringify(imager), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/invoke") {
        if (opts.fail) return json({ ok: false, error: opts.fail });
        if (opts.pending) return json({ ok: true, pending: true, poll: "tok" });
        if (opts.empty) return json({ ok: true, output: {} });
        return json({ ok: true, output: { image: { bytes_b64: PNG_B64, mime: "image/png" } } });
      }
      return json({ ok: false, error: "not found" }, 404);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A minimal in-memory R2 stand-in: enough for put/get/head over the artifact route. */
function memoryBucket() {
  const store = new Map<string, { bytes: Uint8Array; mime: string }>();
  return {
    store,
    bucket: {
      put: async (key: string, bytes: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) => {
        store.set(key, { bytes, mime: opts?.httpMetadata?.contentType || "application/octet-stream" });
        return {};
      },
      get: async (key: string) => {
        const hit = store.get(key);
        if (!hit) return null;
        return {
          body: new Blob([hit.bytes]).stream(),
          arrayBuffer: async () => hit.bytes.buffer,
          size: hit.bytes.length,
          httpMetadata: { contentType: hit.mime },
          writeHttpMetadata: () => {},
        };
      },
      head: async (key: string) => {
        const hit = store.get(key);
        return hit ? { size: hit.bytes.length, httpMetadata: { contentType: hit.mime } } : null;
      },
    },
  };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

/** separateChatBucket reproduces the pre-fix cf#140 topology: R2 distinct from R2_RENDERS. */
function envWith(module: unknown, separateChatBucket = false) {
  const served = memoryBucket();
  const chat = separateChatBucket ? memoryBucket() : served;
  return {
    env: {
      ALLOW_UNAUTHENTICATED: "true",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
      R2_RENDERS: served.bucket,
      R2: chat.bucket,
      ...(module ? { MODULE_ACMEIMAGEGEN: module } : {}),
    } as unknown as Env,
    served,
    chat,
  };
}

function chat(env: Env, model: string) {
  return worker.fetch(
    new Request("https://studio.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, user_input: "a quiet harbor at dawn" }),
    }),
    env,
    ctx,
  );
}

describe("POST /api/chat image path (module-dispatched)", () => {
  beforeEach(() => _resetModuleDiscoveryCache());

  it("dispatches to the declaring module and returns its artifact", async () => {
    const { env } = envWith(imageModuleWorker());
    const res = await chat(env, IMAGE_MODEL_IDS[0]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model_type: string; output_artifact: { key: string; mime: string } };
    expect(body.model_type).toBe("image");
    expect(body.output_artifact.key).toMatch(/^out\//);
    expect(body.output_artifact.mime).toBe("image/png");
  });

  // NOTE, verified by deliberately reverting the fix: this test ALONE does NOT catch cf#140. In this
  // fixture R2 and R2_RENDERS are the same object, so a write to the wrong binding still reads back
  // and it goes green on the broken code. It earns its place as the happy-path read-back; the test
  // BELOW is the one that actually discriminates. Keeping both, and saying which is which, because a
  // suite where only one assertion does the work is worth naming rather than leaving to be guessed.
  it("cf#140: the artifact it reports is servable from /api/artifact", async () => {
    const { env } = envWith(imageModuleWorker());
    const body = (await (await chat(env, IMAGE_MODEL_IDS[0])).json()) as { output_artifact: { key: string } };
    const served = await worker.fetch(
      new Request(`https://studio.example/api/artifact/${body.output_artifact.key}`),
      env,
      ctx,
    );
    expect(served.status).toBe(200);
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x89); // PNG magic: it is the picture, not some other object
    expect(bytes[1]).toBe(0x50);
  });

  // THE discriminating test. Binds a DISTINCT chat bucket -- the exact pre-fix prod topology, and
  // the reason cf broke while local (which defaults both to one bucket) did not. Confirmed to FAIL
  // when putChatArtifact is reverted to env.R2, and to pass with the fix. This is the assertion that
  // would have caught the original defect before it shipped.
  it("cf#140: still servable even when a SEPARATE chat bucket is bound (split is unexpressible)", async () => {
    const { env, served, chat: chatStore } = envWith(imageModuleWorker(), true);
    const body = (await (await chat(env, IMAGE_MODEL_IDS[0])).json()) as { output_artifact: { key: string } };
    expect(served.store.has(body.output_artifact.key)).toBe(true);
    expect(chatStore.store.has(body.output_artifact.key)).toBe(false);
    const res = await worker.fetch(
      new Request(`https://studio.example/api/artifact/${body.output_artifact.key}`),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("surfaces a module failure instead of reporting a fake success", async () => {
    const { env } = envWith(imageModuleWorker({ fail: "content policy" }));
    const res = await chat(env, IMAGE_MODEL_IDS[0]);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("content policy");
  });

  it("rejects an envelope-correct but EMPTY payload rather than storing a non-picture", async () => {
    const { env } = envWith(imageModuleWorker({ empty: true }));
    const res = await chat(env, IMAGE_MODEL_IDS[0]);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/no image bytes/);
  });

  it("rejects an async (pending) answer honestly instead of silently succeeding", async () => {
    const { env } = envWith(imageModuleWorker({ pending: true }));
    const res = await chat(env, IMAGE_MODEL_IDS[0]);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/asynchronously/);
  });
});
