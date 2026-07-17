// Sessions + magic-link redemption + account resolution (#52).

import { constantTimeEqual, newId, randomToken, sha256Hex } from "./crypto";
import type { MailSender } from "./email";
import { magicLinkMail } from "./email";
import type { Account, AuthProvider, ControlPlaneStore } from "./store";

/** Why an account did not resolve. Distinguishing these lets the caller pick an honest message. */
export type UpsertResult =
  | { ok: true; account: Account; created: boolean }
  | { ok: false; reason: "unavailable" | "signups_closed" };

export const SESSION_COOKIE = "__Host-vp_session";
export const LOGIN_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 30;

const iso = (ms: number): string => new Date(ms).toISOString();

/** Lowercase + trim. Emails are the canonical identity, so they normalize in exactly one place. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Deliberately conservative: one @, no whitespace, a dot in the domain. This is a sanity check to
// keep junk out of the send door, NOT an RFC5322 parser; postern is the authority on deliverability.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function looksLikeEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 254;
}

/**
 * __Host- prefix: the browser enforces Secure + Path=/ + no Domain, so the cookie cannot be planted
 * by a sibling subdomain. That matters here specifically because tenant studios live on sibling
 * subdomains of the same registrable domain (<slug>.studio.vivijure.com).
 * SameSite=Lax (not Strict) is REQUIRED: the magic-link click and the SSO callback are both
 * top-level cross-site GETs, and Strict would drop the cookie on exactly those hops.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function clearedSessionCookie(): string {
  return sessionCookie("", 0);
}

export function readSessionCookie(request: Request): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=") || null;
  }
  return null;
}

/** Mint a session and return the PLAINTEXT token (the only place it exists); D1 stores the hash. */
export async function startSession(store: ControlPlaneStore, accountId: string, now = Date.now()) {
  const token = randomToken();
  const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60;
  await store.createSession(await sha256Hex(token), accountId, iso(now + maxAge * 1000));
  return { token, maxAge };
}

/** Resolve the session cookie to an account. A suspended or deleted account resolves to null. */
export async function resolveSession(
  store: ControlPlaneStore,
  request: Request,
  now = Date.now(),
): Promise<Account | null> {
  const token = readSessionCookie(request);
  if (!token) return null;
  const session = await store.getSession(await sha256Hex(token), iso(now));
  if (!session) return null;
  const account = await store.getAccountById(session.account_id);
  if (!account || account.suspended_at || account.deleted_at) return null;
  return account;
}

export async function endSession(store: ControlPlaneStore, request: Request, now = Date.now()): Promise<void> {
  const token = readSessionCookie(request);
  if (token) await store.revokeSession(await sha256Hex(token), iso(now));
}

/**
 * Send a magic link. The caller returns 202 REGARDLESS of what happens in here (including a send
 * failure) so the response cannot be used to enumerate accounts. Failures throw and are logged,
 * never surfaced to the client.
 */
export async function sendMagicLink(
  store: ControlPlaneStore,
  mailer: MailSender,
  publicOrigin: string,
  email: string,
  now = Date.now(),
): Promise<void> {
  const token = randomToken();
  await store.createLoginToken(
    await sha256Hex(token),
    email,
    iso(now + LOGIN_TTL_MINUTES * 60 * 1000),
  );
  const link = `${publicOrigin}/auth/email/callback?token=${token}`;
  const { subject, text } = magicLinkMail(link, LOGIN_TTL_MINUTES);
  await mailer.send(email, subject, text);
}

/**
 * Redeem a magic link: single-use (the store's UPDATE is the guard), and a successful first
 * redemption creates the account. Signup and login are the same flow by design.
 *
 * allowCreate is threaded through rather than assumed: signups can be switched off in the window
 * between a link being mailed and being clicked, and an admin switch that a stale link walks
 * straight through is not a switch.
 */
export async function redeemMagicLink(
  store: ControlPlaneStore,
  token: string,
  allowCreate: boolean,
  now = Date.now(),
): Promise<UpsertResult> {
  const row = await store.consumeLoginToken(await sha256Hex(token), iso(now));
  if (!row) return { ok: false, reason: "unavailable" };
  return await upsertAccountForVerifiedEmail(store, "email", row.email, row.email, allowCreate);
}

/**
 * The account-linking rule, in ONE place so every provider obeys it.
 *
 * Callers MUST have established that the provider asserts this email as VERIFIED. Linking an
 * unverified provider email to an existing account is the classic hand-rolled-SSO account takeover:
 * anyone who can set an arbitrary unverified email at any provider would inherit the account. The
 * providers' verification claims are checked in oauth.ts before this is ever reached.
 *
 * Creation is decided BEFORE it happens (allowCreate), never created-then-rejected: a rejected
 * signup must leave no account behind.
 */
export async function upsertAccountForVerifiedEmail(
  store: ControlPlaneStore,
  provider: AuthProvider,
  subject: string,
  verifiedEmail: string,
  allowCreate: boolean,
): Promise<UpsertResult> {
  const email = normalizeEmail(verifiedEmail);

  const linkedId = await store.getAccountIdByIdentity(provider, subject);
  if (linkedId) {
    const account = await store.getAccountById(linkedId);
    if (!account || account.suspended_at || account.deleted_at) return { ok: false, reason: "unavailable" };
    await store.touchIdentityLogin(provider, subject);
    return { ok: true, account, created: false };
  }

  const existing = await store.getAccountByEmail(email);
  if (existing && (existing.suspended_at || existing.deleted_at)) return { ok: false, reason: "unavailable" };

  // An existing account may always link a new verified identity; only a NEW account is a signup.
  if (!existing && !allowCreate) return { ok: false, reason: "signups_closed" };

  const account = existing ?? (await store.createAccount(newId("acct"), email));
  await store.linkIdentity(provider, subject, account.id);
  await store.touchIdentityLogin(provider, subject);
  return { ok: true, account, created: !existing };
}

/** Admin gate: constant-time bearer compare. Fails CLOSED when the secret is unset. */
export async function isAdmin(presented: string | null, secret: string | undefined): Promise<boolean> {
  if (!presented || !secret) return false;
  return await constantTimeEqual(presented, secret);
}
