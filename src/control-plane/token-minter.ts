// The R2 credential seam (#53), split out on the integration ruling.
//
// WHY ITS OWN SEAM: minting the per-tenant, bucket-scoped R2 credential is the ONE provisioning
// capability our API-created provisioner token cannot perform. Cloudflare refuses API-created
// tokens any token-management rights ("sub-token is not allowed to have permissions to manage
// other tokens"), so this needs a DASHBOARD-created credential. That is a cred problem, not a code
// problem, and it is confined here so the other six provisioning legs are live-verifiable today
// instead of being held hostage to it. Asserted, not assumed: tests/control-plane/cf-api.live.test.ts
// proves the mint really is refused, and that negative control flips the day the right cred lands.
//
// PARKED (do NOT build toward it yet; it is a contract change and parity-bound): per-job temporary
// R2 credentials via the R2 temp-access-credentials API, so tenant-readable RunPod templates would
// carry no long-lived creds at all. Noted here so the intent is not lost, not as a TODO to action.

import type { CfApi } from "./cf-api";

/** A minted credential. The VALUE is a secret: it goes straight into a worker secret and is dropped. */
export interface MintedR2Credential {
  /** The token id. Safe to store: teardown revokes by it. */
  id: string;
  /** The token value. NEVER stored, never logged, never returned to a caller. */
  value: string;
}

export interface TokenMinter {
  mintBucketToken(name: string, bucket: string): Promise<MintedR2Credential>;
  revoke(tokenId: string): Promise<void>;
}

/** The real minter. Blocked today on a dashboard-created credential; the code is ready for it. */
export class CfTokenMinter implements TokenMinter {
  constructor(
    private readonly cf: CfApi,
    private readonly permissionGroupId: string,
  ) {}

  async mintBucketToken(name: string, bucket: string): Promise<MintedR2Credential> {
    return await this.cf.mintR2Token(name, bucket, this.permissionGroupId);
  }

  async revoke(tokenId: string): Promise<void> {
    await this.cf.revokeToken(tokenId);
  }
}
