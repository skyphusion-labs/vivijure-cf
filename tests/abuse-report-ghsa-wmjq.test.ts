import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { isSpendRoute, isSafetyRoute, __resetRateLimitWarnForTest } from "../src/rate-limit";
import { keyRefusal } from "../src/abuse-report";

// Ref GHSA-wmjq-7647-h45x. The three invariants of the report door, asserted separately because
// they have separate mechanisms: (a) a reported key is scoped to the artifact allowlist and to the
// reported project, (b) the route is metered but can never be silenced by its own meter, (c) a held
// original stops being servable.
//
// These drive the door through worker.fetch and assert on HTTP status plus BUCKET STATE, using only
// APIs that predate the change, so each one can be run against the tree without the change and be
// seen to fail. That is deliberate: a regression test that imports a NEW symbol fails on the missing
// import when run that way, which looks red while proving nothing. The keyRefusal unit table at the
// bottom does import a new export and is added COVERAGE, not the proof; it is marked as such so the
// two never get confused.
//
// Each group also carries a positive control, because most assertions here are of the form "the door
// refused" and a door that refused everything would satisfy them all:
//   (a) a legitimate in-project key is still accepted and copied;
//   (b) a real spend route is still denied by the fail-closed limiter in the SAME env where the
//       report door is let through, so the carve-out is visibly a carve-out and not an absent check;
//   (c) a copy that does not land leaves the original in place AND says so.

interface Stored { bytes: Uint8Array; mime: string }

async function drain(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const rd = s.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** opts.dropCopies models a put that reports success while the object never lands. */
function makeEnv(opts: { dropCopies?: boolean; limiter?: boolean } = {}) {
  const r2 = new Map<string, Stored>();
  const stream = (u8: Uint8Array) =>
    new ReadableStream<Uint8Array>({ start(c) { c.enqueue(u8); c.close(); } });
  const env = {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    // SPEND_RATE_LIMITER deliberately UNBOUND unless asked for, and SPEND_LIMIT_FAIL_CLOSED unset,
    // which is the fail-CLOSED default. That is the env in which the door must still work.
    ...(opts.limiter ? { SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) } } : {}),
    R2_RENDERS: {
      async head(key: string) {
        const o = r2.get(key);
        return o ? { size: o.bytes.length, httpMetadata: { contentType: o.mime } } : null;
      },
      async get(key: string) {
        const o = r2.get(key);
        if (!o) return null;
        return { size: o.bytes.length, body: stream(o.bytes), httpMetadata: { contentType: o.mime } };
      },
      async put(key: string, body: unknown, o?: { httpMetadata?: { contentType?: string } }) {
        const isHoldNote = key.endsWith("HOLD.json");
        if (opts.dropCopies && key.startsWith("quarantine/") && !isHoldNote) return;
        const bytes = typeof body === "string"
          ? new TextEncoder().encode(body)
          : await drain(body as ReadableStream<Uint8Array>);
        r2.set(key, { bytes, mime: o?.httpMetadata?.contentType || "application/octet-stream" });
      },
      async delete(key: string) { r2.delete(key); },
    },
  } as unknown as Env;
  return { env, r2 };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const url = (path: string) => `https://studio.example${path}`;

function seed(r2: Map<string, Stored>, key: string, mime = "video/mp4") {
  r2.set(key, { bytes: new Uint8Array([1, 2, 3, 4]), mime });
}

function report(env: Env, body: unknown) {
  return worker.fetch(new Request(url("/api/report"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, ctx);
}

const quarantined = (r2: Map<string, Stored>) =>
  [...r2.keys()].filter((k) => k.startsWith("quarantine/") && !k.endsWith("HOLD.json"));

// --- facet (a): the door may only reach a servable artifact of the reported project --------------

describe("GHSA-wmjq-7647-h45x (a) reported keys are bound to the artifact allowlist and the project", () => {
  it("refuses a safe key that is not a servable artifact, and copies nothing", async () => {
    const { env, r2 } = makeEnv();
    seed(r2, "internal/ops-notes.txt", "text/plain");
    const res = await report(env, { project: "film", keys: ["internal/ops-notes.txt"] });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("unsafe key");
    // The object is untouched and nothing was written into quarantine/.
    expect(r2.has("internal/ops-notes.txt")).toBe(true);
    expect(quarantined(r2)).toEqual([]);
  });

  it("refuses a renders/ key belonging to a DIFFERENT project", async () => {
    const { env, r2 } = makeEnv();
    seed(r2, "renders/other-film/clips/shot-1.mp4");
    const res = await report(env, { project: "my-film", keys: ["renders/other-film/clips/shot-1.mp4"] });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("key outside the reported project");
    expect(r2.has("renders/other-film/clips/shot-1.mp4")).toBe(true);
    expect(quarantined(r2)).toEqual([]);
  });

  it("POSITIVE CONTROL: the reported project's OWN artifact is still accepted and copied", async () => {
    const { env, r2 } = makeEnv();
    seed(r2, "renders/my-film/clips/shot-1.mp4");
    const res = await report(env, { project: "my-film", keys: ["renders/my-film/clips/shot-1.mp4"] });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; copied: number };
    expect(body.ok).toBe(true);
    expect(body.copied).toBe(1);
    const held = quarantined(r2);
    expect(held.length).toBe(1);
    expect(held[0].endsWith("renders/my-film/clips/shot-1.mp4")).toBe(true);
  });

  it("refuses a project name whose slug does not own the key (whitespace slugging is not a bypass)", async () => {
    const { env, r2 } = makeEnv();
    seed(r2, "renders/my_film/clips/shot-1.mp4");
    // renderSlug("my film") === "my_film", so this one is the SAME project and must be accepted.
    const ok = await report(env, { project: "my film", keys: ["renders/my_film/clips/shot-1.mp4"] });
    expect(ok.status).toBe(200);
    // ...while a neighbouring project that merely shares a prefix must not be.
    seed(r2, "renders/my_film_2/clips/shot-1.mp4");
    const no = await report(env, { project: "my film", keys: ["renders/my_film_2/clips/shot-1.mp4"] });
    expect(no.status).toBe(400);
    expect(r2.has("renders/my_film_2/clips/shot-1.mp4")).toBe(true);
  });
});

// --- facet (b): the door is metered, and the meter can never silence it -------------------------

describe("GHSA-wmjq-7647-h45x (b) the report door is metered", () => {
  it("POST /api/report is a metered route", () => {
    expect(isSpendRoute("POST", "/api/report")).toBe(true);
  });

  it("is classified as a SAFETY route, so a broken meter cannot deny it", () => {
    expect(isSafetyRoute("POST", "/api/report")).toBe(true);
    // Discrimination: a money route is NOT a safety route, or the carve-out would disable
    // fail-closed everywhere.
    expect(isSafetyRoute("POST", "/api/storyboard/render")).toBe(false);
    expect(isSafetyRoute("GET", "/api/report")).toBe(false);
  });

  it("still accepts a report when the limiter is UNBOUND under the fail-closed default", async () => {
    __resetRateLimitWarnForTest();
    const { env, r2 } = makeEnv();
    seed(r2, "renders/my-film/clips/shot-1.mp4");
    const res = await report(env, { project: "my-film", keys: ["renders/my-film/clips/shot-1.mp4"] });
    // A 503 here would mean a missing binding had switched the takedown door off.
    expect(res.status).toBe(200);
  });

  it("POSITIVE CONTROL: the same env DOES fail closed for a real spend route", async () => {
    __resetRateLimitWarnForTest();
    const { env } = makeEnv();
    const res = await worker.fetch(new Request(url("/api/storyboard/render"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "my-film" }),
    }), env, ctx);
    // Proves fail-closed is genuinely armed in this env, so the previous test's 200 is the
    // carve-out working and not a limiter that was never consulted.
    expect(res.status).toBe(503);
  });
});

// --- facet (c): a reported original must stop being served --------------------------------------

describe("GHSA-wmjq-7647-h45x (c) a held original stops being servable", () => {
  const KEY = "renders/my-film/clips/shot-1.mp4";

  it("serves the artifact BEFORE the report (the instrument can show the live state)", async () => {
    const { env, r2 } = makeEnv();
    seed(r2, KEY);
    const res = await worker.fetch(new Request(url(`/api/artifact/${KEY}`)), env, ctx);
    expect(res.status).toBe(200);
  });

  it("removes the original once the quarantine copy is verified, and 404s the serve route", async () => {
    const { env, r2 } = makeEnv();
    seed(r2, KEY);
    const res = await report(env, { project: "my-film", keys: [KEY] });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; copied: number; removed: number };
    expect(body).toMatchObject({ ok: true, copied: 1, removed: 1 });
    // Bucket state, not just the response body.
    expect(r2.has(KEY)).toBe(false);
    expect(quarantined(r2).length).toBe(1);
    // The property that matters to a reporter: it is no longer fetchable.
    const after = await worker.fetch(new Request(url(`/api/artifact/${KEY}`)), env, ctx);
    expect(after.status).toBe(404);
  });

  it("writes a hold note recording the originals it removed", async () => {
    const { env, r2 } = makeEnv();
    seed(r2, KEY);
    const res = await report(env, { project: "my-film", keys: [KEY], reason: "actual knowledge" });
    const { note_key } = await res.json() as { note_key: string };
    const note = r2.get(note_key);
    expect(note).toBeTruthy();
    const parsed = JSON.parse(new TextDecoder().decode(note!.bytes)) as {
      removed: string[]; copied: string[]; reason: string;
    };
    expect(parsed.removed).toEqual([KEY]);
    expect(parsed.copied.length).toBe(1);
    expect(parsed.reason).toBe("actual knowledge");
  });

  it("POSITIVE CONTROL: a copy that does not land never deletes the original, and reports it", async () => {
    const { env, r2 } = makeEnv({ dropCopies: true });
    seed(r2, KEY);
    const res = await report(env, { project: "my-film", keys: [KEY] });
    // Honest partial: no ok:true for a takedown that did not happen.
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string; failed: number; removed: number };
    expect(body.failed).toBe(1);
    expect(body.removed).toBe(0);
    // Evidence is not destroyed by a failed copy.
    expect(r2.has(KEY)).toBe(true);
    const after = await worker.fetch(new Request(url(`/api/artifact/${KEY}`)), env, ctx);
    expect(after.status).toBe(200);
  });
});

// --- added coverage (NOT the red-before instrument: imports a new export) ------------------------

describe("keyRefusal rule table", () => {
  it("accepts the deploy-wide artifact namespaces, which carry no project segment", () => {
    expect(keyRefusal("my-film", "cast/ada.png")).toBeNull();
    expect(keyRefusal("my-film", "uploads/source.mp4")).toBeNull();
    expect(keyRefusal("my-film", "loras/ada.safetensors")).toBeNull();
  });

  it("refuses traversal, absolute, non-string and quarantine self-reference", () => {
    expect(keyRefusal("my-film", "renders/my-film/../../etc/passwd")).toBe("unsafe key");
    expect(keyRefusal("my-film", "/renders/my-film/a.mp4")).toBe("unsafe key");
    expect(keyRefusal("my-film", 42)).toBe("unsafe key");
    expect(keyRefusal("my-film", "quarantine/2026/HOLD.json")).toBe("unsafe key");
  });

  it("refuses the bare project prefix with no object after it", () => {
    expect(keyRefusal("my-film", "renders/my-film/")).toBe("key outside the reported project");
  });
});
