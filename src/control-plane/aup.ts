// The AUP gate (#52). Versioned, blocking, logged.
//
// The gate is a LOOKUP FOR THE CURRENT VERSION, never a boolean flag on the account. That is the
// whole design: bumping AUP_VERSION re-gates every account on their next request, by construction,
// with no migration and no backfill. A boolean would silently grandfather everyone through a
// changed policy, which is exactly what a versioned acceptance record exists to prevent.
//
// The CSAM bright line and the acceptable-use posture are not negotiable and not soft-launched:
// this gate is in front of provisioning from day one, so no tenant studio can exist without a
// recorded, versioned acceptance by a known account. Ernst owns the words (#57); we own the gate.

import { sha256Hex } from "./crypto";
import type { ControlPlaneStore } from "./store";

/** Routes reachable by an authenticated account that has NOT yet accepted the current AUP. */
const AUP_EXEMPT = new Set(["/api/me", "/api/aup/current", "/api/aup/accept", "/api/auth/logout"]);

export function isAupExempt(path: string): boolean {
  return AUP_EXEMPT.has(path);
}

export async function hasAcceptedCurrent(
  store: ControlPlaneStore,
  accountId: string,
  version: string,
): Promise<boolean> {
  return await store.hasAcceptedAup(accountId, version);
}

/**
 * Record acceptance. Rejects a stale version rather than accepting it: a client that submits an
 * old version has read old text, so honoring it would log consent to something the user never saw.
 */
export async function acceptAup(
  store: ControlPlaneStore,
  accountId: string,
  submittedVersion: string,
  currentVersion: string,
  request: Request,
): Promise<{ ok: true } | { ok: false; error: "aup_version_stale"; current: string }> {
  if (submittedVersion !== currentVersion) {
    return { ok: false, error: "aup_version_stale", current: currentVersion };
  }
  // The IP is HASHED, never stored raw: the record must prove who accepted what and when, which a
  // hash does, without turning the acceptance log into a location dataset.
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256Hex(ip) : null;
  const ua = request.headers.get("user-agent");
  await store.recordAupAcceptance(accountId, currentVersion, ipHash, ua ? ua.slice(0, 256) : null);
  return { ok: true };
}
