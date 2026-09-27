import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { ARTIFACT_PREFIXES } from "../src/shared";

// The abuse-report door copies a reported key into quarantine/, head-confirms the copy, and then
// DELETES the original. It is a destructive primitive, and its own header comment used to claim a
// reported key "belongs to the reported project" -- flatly -- while the code held that for exactly
// ONE of the twelve ARTIFACT_PREFIXES.
//
// THE FIX IS NOT TO REFUSE THE OTHER ELEVEN. cast/, uploads/, character-refs/ and cast-gen/ are
// where caller-supplied imagery lands, so they are the most likely home of genuinely offending
// content; refusing a report we cannot attribute would make that content unreportable and trade a
// griefing bound for a child-safety takedown path. The door stays open. What changes is that it
// stops CLAIMING an attribution it does not have.
//
// So there are three outcomes, and every case below pins which one it expects:
//   bound    ownership derived, matches the reported project  -> accepted
//   foreign  ownership derived, belongs to ANOTHER project     -> REFUSED
//   unbound  ownership not derivable                           -> accepted, recorded as unbound

const PROJECT = "neon";

/** Exactly the key spaces that can be attributed to a project, and how.
 *  renders/ carries the slug in the key; bundles/ and out/ resolve against renders rows.
 *  cast_members has NO project_id (migrations/0001_init.sql), so everything cast-shaped is
 *  deploy-wide by construction and genuinely has nothing to bind to. */
const DERIVABLE = ["renders/", "bundles/", "out/"] as const;
const NOT_DERIVABLE = ARTIFACT_PREFIXES.filter((p) => !DERIVABLE.includes(p as never));

interface Stored { bytes: Uint8Array; mime: string }

function makeEnv(opts: {
  seed: Record<string, string>;
  /** key -> owning project, as the renders table would answer. */
  owners?: Record<string, string>;
  noDb?: boolean;
  dbThrows?: boolean;
}) {
  const r2 = new Map<string, Stored>();
  for (const [k, v] of Object.entries(opts.seed)) {
    r2.set(k, { bytes: new TextEncoder().encode(v), mime: "application/octet-stream" });
  }
  const stream = (u8: Uint8Array) =>
    new ReadableStream<Uint8Array>({ start(c) { c.enqueue(u8); c.close(); } });

  const env: Record<string, unknown> = {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    // The report route IS in SPEND_PATTERNS and IS a SAFETY route (throttled, never denied by a
    // broken check). Bound to a passing limiter so no assertion here is observing the limiter.
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
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
        const bytes = typeof body === "string"
          ? new TextEncoder().encode(body)
          : new Uint8Array(await new Response(body as ReadableStream).arrayBuffer());
        r2.set(key, { bytes, mime: o?.httpMetadata?.contentType || "application/octet-stream" });
      },
      async delete(key: string) { r2.delete(key); },
    },
  };
  if (!opts.noDb) {
    env.DB = {
      prepare(_sql: string) {
        return {
          bind(k: string) {
            return {
              async first<T>() {
                if (opts.dbThrows) throw new Error("D1_ERROR: no such table: renders");
                const owner = opts.owners?.[k];
                return (owner ? { project: owner } : null) as T | null;
              },
            };
          },
        };
      },
    };
  }
  return { env: env as unknown as Env, r2 };
}

async function report(env: Env, project: string, keys: string[]) {
  const res = await worker.fetch(
    new Request("https://studio.example.org/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, reason: "test", keys }),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  let body: Record<string, unknown> = {};
  try { body = (await res.clone().json()) as Record<string, unknown>; } catch { /* ignore */ }
  return { status: res.status, body };
}

/** Read back the hold note the door just wrote. It is the record somebody acts on. */
function holdNote(r2: Map<string, Stored>): Record<string, unknown> | null {
  const k = [...r2.keys()].find((x) => x.endsWith("HOLD.json"));
  if (!k) return null;
  return JSON.parse(new TextDecoder().decode(r2.get(k)!.bytes)) as Record<string, unknown>;
}

describe("the report door attributes what it can and says so when it cannot", () => {
  it("DENOMINATOR: every ARTIFACT_PREFIXES member is classified derivable or not", () => {
    // A thirteenth prefix cannot arrive without someone deciding which side it is on. This is the
    // case that stops an unscoped namespace appearing unnoticed, which is how this defect began.
    expect(ARTIFACT_PREFIXES).toHaveLength(12);
    expect([...DERIVABLE].sort()).toEqual(["bundles/", "out/", "renders/"]);
    expect(NOT_DERIVABLE).toHaveLength(9);
    expect([...DERIVABLE, ...NOT_DERIVABLE].sort()).toEqual([...ARTIFACT_PREFIXES].sort());
  });

  it("CONTROL: an IN-project renders/ key is accepted, removed, and recorded BOUND", async () => {
    const key = `renders/${PROJECT}/clips/shot_01.mp4`;
    const { env, r2 } = makeEnv({ seed: { [key]: "offending" } });
    const { status, body } = await report(env, PROJECT, [key]);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(r2.has(key)).toBe(false);
    const note = holdNote(r2)!;
    expect(note.attribution).toBe("all-keys-bound");
    expect(note.unbound_count).toBe(0);
    expect((note.bindings as { basis: string }[])[0].basis).toBe("renders-key-segment");
  });

  it("CONTROL: an OUT-of-project renders/ key is REFUSED and the original survives", async () => {
    const key = "renders/someone-else/clips/shot_01.mp4";
    const { env, r2 } = makeEnv({ seed: { [key]: "not yours" } });
    const { status } = await report(env, PROJECT, [key]);
    expect(status).not.toBe(200);
    expect(r2.has(key)).toBe(true);
  });

  it("a FOREIGN bundles/ key is REFUSED -- the new bound this fix adds", async () => {
    const key = "bundles/abc123.json";
    const { env, r2 } = makeEnv({ seed: { [key]: "x" }, owners: { [key]: "someone-else" } });
    const { status } = await report(env, PROJECT, [key]);
    expect(status).not.toBe(200);
    expect(r2.has(key)).toBe(true);
  });

  it("an IN-project bundles/ key is accepted and recorded with the column that proved it", async () => {
    const key = "bundles/abc123.json";
    const { env, r2 } = makeEnv({ seed: { [key]: "x" }, owners: { [key]: PROJECT } });
    const { status } = await report(env, PROJECT, [key]);
    expect(status).toBe(200);
    expect(r2.has(key)).toBe(false);
    expect((holdNote(r2)!.bindings as { basis: string }[])[0].basis).toBe("renders.bundle_key");
  });

  for (const prefix of NOT_DERIVABLE) {
    it(`a ${prefix} key is ACCEPTED and recorded UNBOUND, so it stays reportable`, async () => {
      const key = `${prefix}someone-else/thing.bin`;
      const { env, r2 } = makeEnv({ seed: { [key]: "possibly offending" } });
      const { status, body } = await report(env, PROJECT, [key]);
      // Reportability is the point: refusing here would make offending content unreportable.
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.unbound_keys).toBe(1);
      const note = holdNote(r2)!;
      // And the record must say so UNAMBIGUOUSLY. If this can pass while the report reads as
      // project-scoped, the fix has reintroduced the claim it removes.
      expect(note.attribution).toBe("no-keys-bound");
      expect(note.unbound_count).toBe(1);
      expect(note.bound_count).toBe(0);
      expect(String(note.project_is)).toContain("the reporter's claim");
      const b = (note.bindings as { key: string; kind: string; basis: string; owner: string | null }[])[0];
      expect(b.kind).toBe("unbound");
      expect(b.basis).toBe("not-derivable");
      expect(b.owner).toBeNull();
    });
  }

  it("a MIXED report records partial attribution rather than rounding to either end", async () => {
    const bound = `renders/${PROJECT}/clips/a.mp4`;
    const unbound = "uploads/deadbeef.png";
    const { env, r2 } = makeEnv({ seed: { [bound]: "a", [unbound]: "b" } });
    const { status } = await report(env, PROJECT, [bound, unbound]);
    expect(status).toBe(200);
    const note = holdNote(r2)!;
    expect(note.attribution).toBe("partially-bound");
    expect(note.bound_count).toBe(1);
    expect(note.unbound_count).toBe(1);
  });

  it("'could not look' is recorded differently from 'looked and found nothing'", async () => {
    // Two states that would otherwise render identically to whoever reads the hold under a
    // reporting duty. A key with no owning row is a finding; an unavailable DB is not.
    const key = "bundles/abc123.json";

    const noRow = makeEnv({ seed: { [key]: "x" }, owners: {} });
    expect((await report(noRow.env, PROJECT, [key])).status).toBe(200);
    expect((holdNote(noRow.r2)!.bindings as { basis: string }[])[0].basis).toBe("no-owning-row");

    const noDb = makeEnv({ seed: { [key]: "x" }, noDb: true });
    expect((await report(noDb.env, PROJECT, [key])).status).toBe(200);
    expect((holdNote(noDb.r2)!.bindings as { basis: string }[])[0].basis).toBe("db-unavailable");

    const broken = makeEnv({ seed: { [key]: "x" }, dbThrows: true });
    expect((await report(broken.env, PROJECT, [key])).status).toBe(200);
    expect((holdNote(broken.r2)!.bindings as { basis: string }[])[0].basis).toBe("db-unavailable");
  });

  it("a broken lookup does not CLOSE the door -- the report is still filed", async () => {
    // Fail-open on reportability is deliberate and is the same posture the limiter takes on this
    // route. A safety door that shuts when a database hiccups is a safety door that is not there.
    const key = "bundles/abc123.json";
    const { env, r2 } = makeEnv({ seed: { [key]: "x" }, dbThrows: true });
    const { status, body } = await report(env, PROJECT, [key]);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(r2.has(key)).toBe(false);
  });

  it("served-space is still checked first: quarantine/ and traversal are refused", async () => {
    const { env } = makeEnv({ seed: {} });
    expect((await report(env, PROJECT, ["quarantine/2026/hold/renders/x.mp4"])).status).not.toBe(200);
    expect((await report(env, PROJECT, ["../../etc/passwd"])).status).not.toBe(200);
    expect((await report(env, PROJECT, ["not-an-artifact/x.bin"])).status).not.toBe(200);
  });
});
