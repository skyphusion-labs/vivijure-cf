import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { abuseReportUrl } from "../src/abuse-contact";
import { abuseLink } from "../public/abuse-link-checks.js";

// THE ABUSE-REPORT LINK (control-plane#130).
//
// Enforcement on the hosted tier is report-driven by ruling: nothing is scanned, so a report from a
// person is the entire detection surface, and a findable intake path is part of the product. The
// panel is where a render is actually seen, so it has to carry one.
//
// The hard constraint, and what most of these tests are really about: THIS BUNDLE IS WHAT A
// SELF-HOSTER INSTALLS. Our address must never ship inside it, because we are not the provider for
// a self-hosted studio and cannot act on its content.

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");
const readAsset = (name: string) => readFileSync(join(PUBLIC_DIR, name), "utf8");

describe("abuseReportUrl (the host side: what the core advertises about itself)", () => {
  it("advertises nothing when no operator set an address", () => {
    // The self-host default, and the shipped behaviour of every deploy that does not opt in.
    expect(abuseReportUrl({})).toBeNull();
    expect(abuseReportUrl({ ABUSE_REPORT_URL: "" })).toBeNull();
    expect(abuseReportUrl({ ABUSE_REPORT_URL: "   " })).toBeNull();
  });

  it("passes through an operator address, http or https", () => {
    expect(abuseReportUrl({ ABUSE_REPORT_URL: "https://vivijure.com/report-abuse.html" })).toBe(
      "https://vivijure.com/report-abuse.html",
    );
    // A self-hoster on a LAN is a real reader of this field, not a hypothetical.
    expect(abuseReportUrl({ ABUSE_REPORT_URL: "http://studio.lan/abuse" })).toBe("http://studio.lan/abuse");
  });

  it("REFUSES a scheme that is not http(s), and says so out loud", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(abuseReportUrl({ ABUSE_REPORT_URL: "javascript:alert(1)" })).toBeNull();
    expect(abuseReportUrl({ ABUSE_REPORT_URL: "data:text/html,<script>" })).toBeNull();
    // A silently ignored misconfiguration is how an operator sets a var, sees nothing, and calls
    // the feature broken. This whole cluster keeps producing changes that reach nobody quietly.
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("REFUSES a relative path, which would resolve against the studio origin", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(abuseReportUrl({ ABUSE_REPORT_URL: "/report-abuse.html" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("abuseLink (the panel side: what actually reaches an href)", () => {
  const payload = (host: unknown) => ({ host } as { host?: { abuse_report_url?: unknown } | null });

  it("renders nothing when the host reports nothing, which is the self-host case", () => {
    expect(abuseLink(payload({ dispatch: true }))).toBeNull();
    expect(abuseLink(payload(null))).toBeNull();
    expect(abuseLink(null)).toBeNull();
    expect(abuseLink(undefined)).toBeNull();
  });

  it("renders the link the host reported", () => {
    const spec = abuseLink(payload({ abuse_report_url: "https://vivijure.com/report-abuse.html" }));
    expect(spec).toEqual({ href: "https://vivijure.com/report-abuse.html", label: "Report abuse" });
  });

  it("REFUSES a javascript: href even though the server already refused it", () => {
    // Not redundant with the server check: a panel can talk to an older core and a core to an older
    // panel. This one defends the DOM (a payload string becomes an href); the server one defends
    // honesty (do not advertise a link that cannot work). Either can be reached without the other.
    expect(abuseLink(payload({ abuse_report_url: "javascript:alert(1)" }))).toBeNull();
    expect(abuseLink(payload({ abuse_report_url: "data:text/html,<script>" }))).toBeNull();
    expect(abuseLink(payload({ abuse_report_url: "  " }))).toBeNull();
    expect(abuseLink(payload({ abuse_report_url: 42 }))).toBeNull();
  });
});

describe("PARITY: nothing about our abuse channel is baked into the shipped panel", () => {
  const assets = readdirSync(PUBLIC_DIR).filter((f) => /\.(js|html|css)$/.test(f));

  it("reads a real, non-trivial set of assets (the control for the assertion below)", () => {
    // Without this, a glob that matched nothing would make the parity assertion vacuously true --
    // the exact shape of "negative tests over a dead capability all pass".
    expect(assets.length).toBeGreaterThan(20);
    expect(assets).toContain("abuse-link.js");
  });

  it("no studio asset carries our abuse address or the hosted report page", () => {
    // The rule this enforces: a self-hosted studio must not advertise an address that reaches
    // someone who cannot act on its content. The link exists ONLY as operator config projected
    // through the host payload, so the string must be absent from every shipped byte here.
    const offenders = assets.filter((f) => {
      const text = readAsset(f);
      return /abuse@skyphusion\.org/.test(text) || /vivijure\.com\/report-abuse/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("the gate has no fallback address to fall back TO", () => {
    // A default would look harmless and would be the whole defect: every self-host install would
    // start advertising us the moment the fetch failed or a field went missing.
    const src = readAsset("abuse-link.js");
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).toMatch(/abuse_report_url|abuseLink/);
  });
});

describe("the route actually carries the field (control-plane#130)", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  const env = (over: Record<string, unknown> = {}) =>
    ({
      ALLOW_UNAUTHENTICATED: "true",
      ASSETS: { fetch: async () => new Response("asset") },
      ...over,
    }) as unknown as Parameters<typeof worker.fetch>[1];

  const hostOf = async (e: Parameters<typeof worker.fetch>[1]) => {
    const res = await worker.fetch(new Request("https://studio.example/api/modules"), e, ctx);
    const body = (await res.json()) as { host?: Record<string, unknown> };
    return body.host ?? {};
  };

  it("omits the field entirely on a studio with no address set", async () => {
    // The self-host shape. Absent, not null and not empty string: the panel treats absence as
    // "there is nothing to advertise", and a present-but-falsy field invites a truthiness bug.
    const host = await hostOf(env());
    expect("abuse_report_url" in host).toBe(false);
    // Control: the payload really was read, so the assertion above is not passing on an empty read.
    expect(host).toHaveProperty("dispatch");
  });

  it("carries the operator address when one is set", async () => {
    const host = await hostOf(env({ ABUSE_REPORT_URL: "https://vivijure.com/report-abuse.html" }));
    expect(host.abuse_report_url).toBe("https://vivijure.com/report-abuse.html");
  });

  it("omits a refused address rather than advertising a broken or dangerous link", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = await hostOf(env({ ABUSE_REPORT_URL: "javascript:alert(1)" }));
    expect("abuse_report_url" in host).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
