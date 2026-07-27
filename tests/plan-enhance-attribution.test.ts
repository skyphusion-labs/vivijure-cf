// Per-tenant attribution for the hosted Opus meter (cp#185).
//
// WHY THIS FILE EXISTS, and why the assertions are shaped the way they are:
//
// The AI Gateway records `authentication` as a BOOLEAN. It logs THAT a request was authenticated,
// never WHICH token authenticated it. So the per-tenant CF_AIG_TOKEN is an access and revocation
// boundary and provides ZERO attribution. The `cf-aig-metadata` header is the entire attribution
// mechanism -- the gateway copies it into the log verbatim, alongside a natively-computed `cost`,
// and the per-tenant meter reads it from there. If this header silently stops being sent, the
// meter does not break loudly: it under-counts, and an under-counting meter bills US rather than
// the tenant. That failure is invisible in production, so it has to be loud here.
//
// Written as a RECORDING PROXY over the outbound fetch asserting what was actually PASSED, not as
// a read of some final state, matching plan-enhance-billing-auth.test.ts. Every block that asserts
// an absence carries a POSITIVE CONTROL first, because "the header was not sent" and "no request
// happened at all" are indistinguishable otherwise, and a vacuous pass here is exactly the class
// of green-that-means-nothing this suite is meant to prevent.

import { describe, it, expect, vi, afterEach } from "vitest";
import { callOpus, aigMetadata } from "../modules/plan-enhance/src/provider";

interface Recorded {
  url: string;
  headerNames: string[];
  headers: Record<string, string>;
}

function recordingFetch(recorded: Recorded[], reply: unknown = { content: [{ type: "text", text: "ok" }] }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const raw = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    recorded.push({ url: String(input), headerNames: Object.keys(headers), headers });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  });
}

function envWith(extra: Record<string, unknown> = {}) {
  return {
    AI: { gateway: () => ({ getUrl: async () => "https://gateway.example/v1/acc/gw/anthropic" }) },
    GATEWAY_ID: "gw",
    CF_AIG_TOKEN: "aig-token",
    ...extra,
  } as never;
}

afterEach(() => vi.unstubAllGlobals());

describe("aigMetadata (pure)", () => {
  it("keys on the tenant id and carries the slug as a label", () => {
    expect(aigMetadata({ TENANT_ID: "ten_abc123", TENANT_SLUG: "rollins-e2e" } as never)).toBe(
      JSON.stringify({ tenant_id: "ten_abc123", slug: "rollins-e2e" }),
    );
  });

  it("emits tenant_id alone when no slug is bound", () => {
    expect(aigMetadata({ TENANT_ID: "ten_abc123" } as never)).toBe(JSON.stringify({ tenant_id: "ten_abc123" }));
  });

  // A slug is renameable, so it is worthless as a ledger key. Attribution keyed on a slug alone
  // would silently re-point a tenant history at a different tenant after a rename.
  it("returns null when only a slug is present -- a slug alone is NOT an attribution key", () => {
    expect(aigMetadata({ TENANT_SLUG: "rollins-e2e" } as never)).toBeNull();
  });

  it("returns null on a self-hosted install with no tenant identity", () => {
    expect(aigMetadata({} as never)).toBeNull();
    expect(aigMetadata({ TENANT_ID: "" } as never)).toBeNull();
    expect(aigMetadata({ TENANT_ID: "   " } as never)).toBeNull();
  });

  // The slug is TENANT-CHOSEN. It reaches an HTTP header, so a raw CR/LF is header injection.
  it("strips CR/LF and other header-unsafe bytes from tenant-chosen values", () => {
    const out = aigMetadata({
      TENANT_ID: "ten_abc123",
      TENANT_SLUG: "evil\r\nx-injected: yes",
    } as never);
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\n");
    expect(out).not.toContain(" ");
    expect(JSON.parse(out as string).slug).toBe("evilx-injected:yes");
  });

  it("drops a value that sanitizes away to nothing rather than emitting an empty key", () => {
    expect(aigMetadata({ TENANT_ID: "!!!" } as never)).toBeNull();
    const out = aigMetadata({ TENANT_ID: "ten_abc123", TENANT_SLUG: "!!!" } as never);
    expect(JSON.parse(out as string)).toEqual({ tenant_id: "ten_abc123" });
  });

  it("caps an over-long value instead of emitting an unbounded header", () => {
    const out = aigMetadata({ TENANT_ID: "t".repeat(500) } as never);
    expect(JSON.parse(out as string).tenant_id.length).toBe(128);
  });
});

describe("callOpus attribution header (cp#185)", () => {
  it("PASSES cf-aig-metadata on the hosted path", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", recordingFetch(recorded));
    await callOpus(envWith({ TENANT_ID: "ten_abc123", TENANT_SLUG: "rollins-e2e" }), [
      { role: "user", content: "hi" },
    ]);

    // POSITIVE CONTROL: the proxy genuinely recorded a call. Without this the assertions below
    // could pass against an empty recording.
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[0].headerNames).toContain("cf-aig-metadata");
    expect(JSON.parse(recorded[0].headers["cf-aig-metadata"])).toEqual({
      tenant_id: "ten_abc123",
      slug: "rollins-e2e",
    });
    // Attribution must not have disturbed the billing boundary it sits next to.
    expect(recorded[0].headers["cf-aig-authorization"]).toBe("Bearer aig-token");
    expect(recorded[0].headerNames).not.toContain("x-api-key");
  });

  // PARITY: a self-hoster must emit exactly the request they emitted before this feature existed.
  it("OMITS the header entirely on a self-hosted install", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", recordingFetch(recorded));
    await callOpus(envWith(), [{ role: "user", content: "hi" }]);

    // POSITIVE CONTROL first: a request really was made, so the absence below is a real absence
    // and not "nothing happened".
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[0].headerNames).toContain("cf-aig-authorization");
    expect(recorded[0].headerNames).not.toContain("cf-aig-metadata");
  });

  it("never emits a raw CR/LF into the outbound header even from a hostile slug", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", recordingFetch(recorded));
    await callOpus(envWith({ TENANT_ID: "ten_abc123", TENANT_SLUG: "a\r\nx-evil: 1" }), [
      { role: "user", content: "hi" },
    ]);
    expect(recorded.length).toBeGreaterThan(0);
    const v = recorded[0].headers["cf-aig-metadata"];
    expect(v).toBeDefined();
    expect(v).not.toMatch(/[\r\n]/);
  });
});
