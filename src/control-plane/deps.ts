// The control plane's ONE injectable seam (#52).
//
// This is the productionReindexDeps discipline from the studio: production has exactly one wiring
// function, tests replace the whole bundle, and there is no second code path that only tests take.
// A stubbed dep set proves a decision path; it never proves the shipped artifact, which is why
// productionDeps() is what the live wrangler dev verify drives.

import { r2StudioBundleSource } from "./bundle-r2";
import { CfApi } from "./cf-api";
import type { ControlPlaneEnv } from "./env";
import type { MailSender } from "./email";
import { posternSender } from "./email";
import { runProvisionJob, type ProvisionDeps } from "./provisioner";
import { createTenantEndpoints } from "./runpod";
import type { ControlPlaneStore, Tenant } from "./store";
import { D1Store } from "./store-d1";
import { STUDIO_MIGRATIONS } from "./studio-migrations";
import { CfTokenMinter } from "./token-minter";

/** The secret name the studio reads its stored invoke key (key B) from (src/env.ts). */
export const TENANT_RUNPOD_SECRET = "RUNPOD_API_KEY";

/**
 * What the router needs from the provisioner: launch a job, install a verified key. The router
 * never sees CfApi or the namespace; custody of both stays here.
 */
export interface ProvisionerWiring {
  /** Run a provision job to completion or honest failure. Never throws; the job row is the record. */
  start(jobId: string, tenant: Tenant, runpodApiKey: string | null): Promise<void>;
  /** Install the VERIFIED invoke key as the tenant studio secret. Throws on API failure. */
  installInvokeKey(tenant: Tenant, key: string): Promise<void>;
}

export interface ControlPlaneDeps {
  store: ControlPlaneStore;
  mailer: MailSender;
  /** Outbound fetch (SSO token exchange, RunPod probes). Injectable so tests never hit the network. */
  fetch: typeof fetch;
  now(): number;
  /**
   * Absent when the deploy lacks any of the provisioner env (env.ts); the provision and invoke-key
   * routes then refuse with 503 provisioner_unconfigured instead of parking tenants on jobs nothing
   * will ever run. That absence-refusal is deliberate and tested, same rule as the admin gate.
   */
  provisioner?: ProvisionerWiring;
}

export function productionDeps(env: ControlPlaneEnv): ControlPlaneDeps {
  const store = new D1Store(env.CP_DB);
  return {
    store,
    mailer: posternSender(env),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    now: () => Date.now(),
    provisioner: provisionerWiring(env, store),
  };
}

/** Exported for the wiring test: the same construction production takes. */
export function provisionerWiring(env: ControlPlaneEnv, store: ControlPlaneStore): ProvisionerWiring | undefined {
  const { CF_PROVISIONER_TOKEN, CF_ACCOUNT_ID, DISPATCH_NAMESPACE, STUDIO_RELEASE, STUDIO_RELEASES } = env;
  if (!CF_PROVISIONER_TOKEN || !CF_ACCOUNT_ID || !DISPATCH_NAMESPACE || !STUDIO_RELEASE || !STUDIO_RELEASES) {
    return undefined;
  }

  const cf = new CfApi(CF_ACCOUNT_ID, CF_PROVISIONER_TOKEN);
  const deps: ProvisionDeps = {
    store,
    cf,
    runpod: { createEndpoints: (key, slug, r2) => createTenantEndpoints(key, slug, r2) },
    bundle: r2StudioBundleSource(STUDIO_RELEASES),
    tokenMinter: new CfTokenMinter(cf),
    r2Endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    namespace: DISPATCH_NAMESPACE,
    release: STUDIO_RELEASE,
    tenantScriptName: (slug) => `tenant-${slug}-studio`,
    // Structured, greppable, and NEVER carries a secret (provisioner discipline).
    log: (event, fields) => console.log("provision", { event, ...fields }),
  };

  return {
    async start(jobId, tenant, runpodApiKey) {
      // runProvisionJob records every outcome on the job row; the return value is the same fact.
      await runProvisionJob(deps, jobId, tenant, runpodApiKey, STUDIO_MIGRATIONS);
    },
    async installInvokeKey(tenant, key) {
      if (!tenant.script_name) throw new Error("tenant has no studio worker to install the key on");
      await cf.putScriptSecret(DISPATCH_NAMESPACE, tenant.script_name, TENANT_RUNPOD_SECRET, key);
    },
  };
}
