// Worker Env binding for the vivijure control plane (#52, epic #40).
//
// Hand-authored interface mirroring wrangler.control-plane.toml.example, per the standing rule.
// Adding a binding: update the wrangler config, then mirror it here.
//
// This is DELIBERATELY not an extension of the studio's src/env.ts. The control plane and the
// studio are separate Workers with disjoint bindings: the control plane never touches a tenant's
// D1 or R2, and the studio does not know the control plane exists.

/** CF rate-limit binding (same shape the studio uses in src/rate-limit.ts). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface ControlPlaneEnv {
  // The front-door UI (Joan, #58), served via Workers Assets. Bundle lives at hosted/public, kept
  // separate from public/ (the studio frontend that ships to every self-hoster).
  ASSETS: Fetcher;

  // Control-plane D1. PLATFORM data only; never tenant studio data.
  CP_DB: D1Database;

  // ---- vars (public identifiers, not secrets) ----

  /** Current AUP version. Bumping this re-gates every account on their next request. */
  AUP_VERSION: string;
  /** Where the AUP text lives (Ernst, #57). The control plane holds no opinion on the words. */
  AUP_URL: string;
  /** e.g. https://studio.vivijure.com -- the CSRF origin and the magic-link/callback base. */
  PUBLIC_ORIGIN: string;
  /** e.g. .studio.vivijure.com -- tenant studios live at <slug><suffix> (Strummer, #55). */
  TENANT_DOMAIN_SUFFIX: string;

  /** postern send door (POST /api/send). Var: it is a URL, not a secret. */
  POSTERN_SEND_URL?: string;

  // SSO client identifiers. A provider is OFFERED only when its id AND secret are both present,
  // which is what makes /api/platform/config a projection rather than a hardcoded list.
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  // Apple seam: parked until Conrad stages Team ID + Services ID + .p8. Present here so the day
  // they land is a config change, not a code change.
  APPLE_TEAM_ID?: string;
  APPLE_SERVICES_ID?: string;

  // ---- secrets ----

  /** postern bearer for the send door. The sender identity is BOUND to this token by postern's
   *  registry (POSTERN_SEND_IDENTITIES) and `from` is authoritative there, so we never pass one. */
  POSTERN_SEND_TOKEN?: string;

  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** The Apple .p8 signing key. Parked with the rest of the Apple seam. */
  APPLE_PRIVATE_KEY?: string;

  /** Admin gate. Bearer, compared constant-time; mirrors the studio's proven token gate. */
  CONTROL_PLANE_ADMIN_TOKEN?: string;

  /** Mints tenant D1 + R2 + scoped creds. Consumed by the provisioner (#53), not by #52. */
  CF_PROVISIONER_TOKEN?: string;

  // ---- optional ----

  /** Throttles the outbound-email amplifier (/api/auth/email/start) and provisioning. */
  CP_RATE_LIMIT?: RateLimiter;
}
