// In-memory ControlPlaneStore for the control-plane logic tests (#52).
//
// WHAT THIS IS FOR, precisely: proving DECISION PATHS (does the gate refuse, is a token single-use,
// does an unverified email get rejected). It is NOT evidence about the shipped artifact. The SQL in
// store-d1.ts is verified against a REAL D1 in the live wrangler dev pass, because a fake store
// encodes my own assumptions about my own SQL and would happily agree with a bug.
//
// It mirrors D1Store's SEMANTICS deliberately, especially the two single-use guards: consume is an
// atomic check-and-set, so a replay finds nothing.

import type {
  Account,
  AuthProvider,
  ControlPlaneStore,
  LoginToken,
  OAuthState,
  ProvisionJob,
  Session,
  Tenant,
  TenantLifecycle,
} from "../../src/control-plane/store";

export class MemoryStore implements ControlPlaneStore {
  accounts = new Map<string, Account>();
  identities = new Map<string, { account_id: string; last_login_at: string | null }>();
  loginTokens = new Map<string, LoginToken>();
  sessions = new Map<string, Session>();
  oauthStates = new Map<string, OAuthState>();
  tenants = new Map<string, Tenant>();
  jobs = new Map<string, ProvisionJob>();
  settings = new Map<string, string>([["signups_enabled", "true"]]);
  audit: { actor: string; action: string; target: string | null; detail: string | null }[] = [];

  private key(p: AuthProvider, s: string) {
    return `${p}:${s}`;
  }

  async getAccountById(id: string) {
    const a = this.accounts.get(id);
    return a && !a.deleted_at ? a : null;
  }
  async getAccountByEmail(email: string) {
    for (const a of this.accounts.values()) if (a.email === email && !a.deleted_at) return a;
    return null;
  }
  async createAccount(id: string, email: string) {
    const a: Account = {
      id,
      email,
      created_at: new Date().toISOString(),
      suspended_at: null,
      suspended_reason: null,
      deleted_at: null,
    };
    this.accounts.set(id, a);
    return a;
  }
  async getAccountIdByIdentity(p: AuthProvider, s: string) {
    return this.identities.get(this.key(p, s))?.account_id ?? null;
  }
  async linkIdentity(p: AuthProvider, s: string, accountId: string) {
    if (!this.identities.has(this.key(p, s))) {
      this.identities.set(this.key(p, s), { account_id: accountId, last_login_at: null });
    }
  }
  async touchIdentityLogin(p: AuthProvider, s: string) {
    const row = this.identities.get(this.key(p, s));
    if (row) row.last_login_at = new Date().toISOString();
  }

  async createLoginToken(token_hash: string, email: string, expires_at: string) {
    this.loginTokens.set(token_hash, { token_hash, email, expires_at, consumed_at: null });
  }
  /** Atomic check-and-set, exactly like the D1 UPDATE guard: a replay updates nothing. */
  async consumeLoginToken(token_hash: string, now: string) {
    const row = this.loginTokens.get(token_hash);
    if (!row || row.consumed_at || row.expires_at <= now) return null;
    row.consumed_at = now;
    return { ...row };
  }

  async createSession(token_hash: string, account_id: string, expires_at: string) {
    this.sessions.set(token_hash, { token_hash, account_id, expires_at, revoked_at: null });
  }
  async getSession(token_hash: string, now: string) {
    const s = this.sessions.get(token_hash);
    if (!s || s.revoked_at || s.expires_at <= now) return null;
    return s;
  }
  async revokeSession(token_hash: string, now: string) {
    const s = this.sessions.get(token_hash);
    if (s && !s.revoked_at) s.revoked_at = now;
  }

  async createOAuthState(row: Omit<OAuthState, "consumed_at">) {
    this.oauthStates.set(row.state, { ...row, consumed_at: null });
  }
  async consumeOAuthState(state: string, now: string) {
    const row = this.oauthStates.get(state);
    if (!row || row.consumed_at || row.expires_at <= now) return null;
    row.consumed_at = now;
    return { ...row };
  }

  aup: { account_id: string; aup_version: string; ip_hash: string | null }[] = [];
  async hasAcceptedAup(account_id: string, version: string) {
    return this.aup.some((r) => r.account_id === account_id && r.aup_version === version);
  }
  async recordAupAcceptance(account_id: string, aup_version: string, ip_hash: string | null) {
    if (!(await this.hasAcceptedAup(account_id, aup_version))) {
      this.aup.push({ account_id, aup_version, ip_hash });
    }
  }

  async getTenantById(id: string) {
    return this.tenants.get(id) ?? null;
  }
  async getTenantBySlug(slug: string) {
    for (const t of this.tenants.values()) if (t.slug === slug) return t;
    return null;
  }
  async getTenantForAccount(account_id: string) {
    for (const t of this.tenants.values()) if (t.account_id === account_id && t.status !== "deleted") return t;
    return null;
  }
  async createTenant(id: string, slug: string, account_id: string, status: TenantLifecycle) {
    const t: Tenant = {
      id,
      slug,
      account_id,
      status,
      script_name: null,
      d1_database_id: null,
      r2_bucket_name: null,
      endpoints_json: null,
      studio_release: null,
      created_at: new Date().toISOString(),
      live_at: null,
      suspended_at: null,
      suspended_reason: null,
      deleted_at: null,
    };
    this.tenants.set(id, t);
    return t;
  }
  async setTenantStatus(id: string, status: TenantLifecycle) {
    const t = this.tenants.get(id);
    if (!t) return;
    t.status = status;
    if (status === "live" && !t.live_at) t.live_at = new Date().toISOString();
  }
  async suspendTenant(id: string, reason: string) {
    const t = this.tenants.get(id);
    if (!t) return;
    t.suspended_at = new Date().toISOString();
    t.suspended_reason = reason;
  }
  async resumeTenant(id: string) {
    const t = this.tenants.get(id);
    if (!t) return;
    t.suspended_at = null;
    t.suspended_reason = null;
  }
  async listTenants(filter: { status?: string; q?: string }) {
    return [...this.tenants.values()].filter(
      (t) =>
        (!filter.status ||
          (filter.status === "suspended" ? t.suspended_at !== null : t.status === filter.status)) &&
        (!filter.q || t.slug.includes(filter.q)),
    );
  }

  async createProvisionJob(id: string, tenant_id: string, kind: "provision" | "deprovision") {
    const j: ProvisionJob = {
      id,
      tenant_id,
      kind,
      status: "queued",
      step: null,
      steps_done: "[]",
      error_step: null,
      error_message: null,
      attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      finished_at: null,
    };
    this.jobs.set(id, j);
    return j;
  }
  async getLatestJobForTenant(tenant_id: string) {
    const all = [...this.jobs.values()].filter((j) => j.tenant_id === tenant_id);
    return all.length ? all[all.length - 1] : null;
  }

  async getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }
  async setSetting(key: string, value: string) {
    this.settings.set(key, value);
  }
  async recordAdminAction(actor: string, action: string, target: string | null, detail: string | null) {
    this.audit.push({ actor, action, target, detail });
  }
}
