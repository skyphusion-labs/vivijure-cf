// Tenant identity rules (#52). The provisioner itself is #53; this owns slugs and the status machine.

import type { Tenant, TenantStatus } from "./store";

/**
 * A slug is BOTH a DNS label (<slug>.studio.vivijure.com) and a Workers-for-Platforms script name,
 * so it is validated ONCE, here, against the intersection of both alphabets. 3..32 chars,
 * lowercase alnum and internal hyphens, no leading/trailing hyphen.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

/**
 * Reserved labels. Two reasons, both load-bearing: a tenant must not be able to mint a hostname
 * that impersonates a platform surface (admin., api., www.), and must not collide with a sibling
 * service on the zone that already exists (demo., studio-mcp.).
 */
const RESERVED = new Set([
  "www", "api", "admin", "administrator", "root", "demo", "studio", "mcp", "studio-mcp",
  "app", "status", "mail", "smtp", "imap", "ns", "ns1", "ns2", "dns", "cdn", "static",
  "assets", "support", "help", "docs", "blog", "billing", "account", "accounts", "auth",
  "login", "signup", "security", "abuse", "postmaster", "webmaster", "test", "staging",
  "dev", "internal", "vivijure",
]);

export type SlugRejection = "too_short" | "too_long" | "bad_shape" | "reserved";

export function validateSlug(slug: string): { ok: true } | { ok: false; reason: SlugRejection } {
  if (slug.length < 3) return { ok: false, reason: "too_short" };
  if (slug.length > 32) return { ok: false, reason: "too_long" };
  if (!SLUG_RE.test(slug)) return { ok: false, reason: "bad_shape" };
  if (RESERVED.has(slug)) return { ok: false, reason: "reserved" };
  return { ok: true };
}

export function slugRejectionMessage(reason: SlugRejection): string {
  switch (reason) {
    case "too_short":
      return "must be at least 3 characters";
    case "too_long":
      return "must be at most 32 characters";
    case "bad_shape":
      return "use lowercase letters, numbers, and hyphens; must start and end with a letter or number";
    case "reserved":
      return "that name is reserved";
  }
}

/** The public projection of a tenant. Never leaks internal provisioning ids to the front door. */
export interface TenantView {
  id: string;
  slug: string;
  status: TenantStatus;
  url: string | null;
  studio_release: string | null;
  created_at: string;
  live_at: string | null;
  suspended_reason: string | null;
}

export function tenantView(tenant: Tenant, domainSuffix: string): TenantView {
  // Suspension is projected OVER the lifecycle, never stored in it. The API contract Joan builds
  // against is unchanged (status may read "suspended"), while the tenant's real lifecycle survives
  // underneath, so resume restores exactly where it left off.
  const suspended = tenant.suspended_at !== null;
  return {
    id: tenant.id,
    slug: tenant.slug,
    status: suspended ? "suspended" : tenant.status,
    // A URL is shown only once there is something behind it; a link that 5xx's is not honest. A
    // suspended tenant gets no URL either, whatever its lifecycle says.
    url: tenant.status === "live" && !suspended ? `https://${tenant.slug}${domainSuffix}` : null,
    studio_release: tenant.studio_release,
    created_at: tenant.created_at,
    live_at: tenant.live_at,
    suspended_reason: tenant.suspended_reason,
  };
}

/** The 4 endpoint ids the provisioner (#53/#54) records; read by the invoke-key scope check. */
export function tenantEndpointIds(tenant: Tenant): string[] {
  if (!tenant.endpoints_json) return [];
  try {
    const parsed: unknown = JSON.parse(tenant.endpoints_json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
