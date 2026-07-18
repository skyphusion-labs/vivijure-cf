// The billing-auth guard for the plan-enhance module (vivijure-local#107).
//
// This decides WHOSE MONEY a request spends, so a silent flip is a billing incident, not a test
// nicety. callOpus routes Anthropic through the AI Gateway on Unified Billing, keyless: an
// x-api-key header would flip the same gateway to BYOK billing.
//
// It replaces a retired test in vivijure-local that asserted a PRIORITY ("gateway wins when both
// credentials are present") against a caller nothing invokes any more. The live module never reads
// ANTHROPIC_API_KEY at all -- it is keyless by construction -- so there is no priority left to get
// wrong, and the guard worth having is the NEGATIVE one: x-api-key must never be emitted, whatever
// is in env. That is strictly stronger: it fails if someone later adds a BYOK fallback.
//
// Written as a RECORDING PROXY over the outbound fetch asserting the header was NEVER PASSED, not
// as a point-in-time read of a final request object: a write-then-delete would sail past that.

import { describe, it, expect, vi, afterEach } from "vitest";
import { callOpus } from "../modules/plan-enhance/src/provider";

interface Recorded {
  url: string;
  headerNames: string[];
  headers: Record<string, string>;
}

/** Records EVERY outbound fetch and every header name it carried. */
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

describe("callOpus billing auth (local#107)", () => {
  it("routes through the AI Gateway with cf-aig-authorization", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", recordingFetch(recorded));
    await callOpus(envWith(), [{ role: "user", content: "hi" }]);

    // POSITIVE CONTROL: the proxy genuinely records. Without this, every "never passed" assertion
    // below would pass vacuously against an empty recording.
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[0].headerNames).toContain("cf-aig-authorization");
    expect(recorded[0].headers["cf-aig-authorization"]).toBe("Bearer aig-token");
  });

  // THE guard. Unified Billing is keyless: an x-api-key flips the gateway to BYOK, i.e. bills a
  // different party. It must never be sent, on ANY request, regardless of what is in env.
  it("NEVER sends x-api-key, even when Anthropic BYOK keys are present in env", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", recordingFetch(recorded));
    await callOpus(
      envWith({
        ANTHROPIC_API_KEY: "sk-ant-should-never-be-used",
        anthropic_api_key: "sk-ant-lowercase-variant",
      }),
      [{ role: "user", content: "hi" }],
    );

    expect(recorded.length).toBeGreaterThan(0);
    for (const call of recorded) {
      expect(call.headerNames).not.toContain("x-api-key");
      expect(call.headerNames).not.toContain("authorization");
      // and the key value must not have leaked into ANY header under a different name
      const values = Object.values(call.headers).join(" ");
      expect(values).not.toContain("sk-ant-should-never-be-used");
      expect(values).not.toContain("sk-ant-lowercase-variant");
    }
  });

  it("refuses to call at all without gateway credentials, rather than falling back to a direct key", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", recordingFetch(recorded));
    await expect(
      callOpus({ AI: { gateway: () => ({ getUrl: async () => "x" }) }, ANTHROPIC_API_KEY: "sk-ant-x" } as never, [
        { role: "user", content: "hi" },
      ]),
    ).rejects.toThrow();
    // The point: no request went out at all. A BYOK fallback would show up as a recorded call here.
    expect(recorded).toEqual([]);
  });
});
