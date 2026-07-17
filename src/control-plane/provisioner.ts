// The tenant provisioner (#53): durable, resumable, idempotent-by-name.
//
// WHAT "RESUMABLE" MEANS HERE, precisely, because the obvious reading is wrong:
// resume RE-RUNS FROM THE TOP; it does not skip completed steps. Every step is idempotent-by-name
// (a create that hits an existing resource ADOPTS it), which is what makes that safe, and it is the
// only honest option: the secret-producing step (the R2 token mint) has no stored output to skip
// with, because we deliberately never store the credential it produces. A skip-list would either
// force us to persist secrets or silently leave a tenant with a worker bound to a credential
// nobody holds. steps_done is therefore a PROGRESS RECORD (for the UI and for honest error
// reporting), not a skip-list.
//
// KEY CUSTODY: the tenant's RunPod key (key A) is a PARAMETER, never a field. It lives in the
// request that carries it and in this function's arguments, and nowhere else: not in D1, not in a
// log, not on the job row. That is why a job failing in the RunPod step cannot self-resume, and why
// /retry answers 409 runpod_key_required instead of quietly re-running with a key it kept.

import type { CfApi } from "./cf-api";
import { CfApiError } from "./cf-api";
import type { ControlPlaneStore, Tenant } from "./store";

/** The named steps, in order. These strings reach the tenant's screen; keep them legible. */
export const PROVISION_STEPS = [
  "d1_create",
  "d1_migrate",
  "r2_bucket",
  "r2_token",
  "runpod_endpoints",
  "wfp_upload",
  "verify",
] as const;
export type ProvisionStep = (typeof PROVISION_STEPS)[number];

/** One of the tenant's 4 RunPod endpoints, as Joan's screens render them. */
export interface TenantEndpoint {
  key: string;
  label: string;
  id: string;
  name: string;
}

/**
 * The RunPod half of provisioning (#54). Split behind a seam because it is a different lane AND a
 * different trust domain: this is the only part that touches the tenant's transient key.
 */
export interface RunPodProvisioner {
  createEndpoints(runpodApiKey: string, slug: string): Promise<TenantEndpoint[]>;
}

/**
 * Where the published studio bundle comes from.
 *
 * SEAM ON PURPOSE, and currently the open question in #53: the control plane is a Worker and cannot
 * build. Nothing in the repo publishes a built studio bundle today (install-module.ts takes a
 * pre-built --code from an operator), so how the release artifact is produced and fetched is a call
 * that crosses into CI/release. Whatever we pick (release asset, R2, npm), it is an implementation
 * of THIS interface and not a rewrite of the provisioner.
 */
export interface StudioBundleSource {
  /** The published release, unmodified. Parity depends on this being the real artifact. */
  fetch(release: string): Promise<{
    mainModule: string;
    moduleText: string;
    compatibilityDate: string;
    compatibilityFlags?: string[];
    assets?: { path: string; base64: string; contentType: string; hash: string; size: number }[];
  }>;
}

export interface ProvisionDeps {
  store: ControlPlaneStore;
  cf: CfApi;
  runpod: RunPodProvisioner;
  bundle: StudioBundleSource;
  namespace: string;
  release: string;
  /** The R2 permission-group id for a bucket-scoped read/write token. Deploy config, not a secret. */
  r2PermissionGroupId: string;
  tenantScriptName(slug: string): string;
  log(event: string, fields: Record<string, unknown>): void;
}

/** Deterministic, tenant-scoped resource names. Idempotency depends on these being stable. */
export const tenantD1Name = (slug: string) => `vivijure-tenant-${slug}`;
export const tenantBucketName = (slug: string) => `vivijure-tenant-${slug}`;
export const tenantR2TokenName = (slug: string) => `vivijure-tenant-${slug}-r2`;

export class ProvisionFailure extends Error {
  constructor(
    readonly step: ProvisionStep,
    message: string,
  ) {
    super(message);
    this.name = "ProvisionFailure";
  }
}

/**
 * Run a provision job to completion or to an honest failure.
 *
 * runpodApiKey is key A: transient, used once, never stored. Pass null to resume the CF-side steps
 * only; the run then stops honestly at runpod_endpoints rather than pretending.
 */
export async function runProvisionJob(
  deps: ProvisionDeps,
  jobId: string,
  tenant: Tenant,
  runpodApiKey: string | null,
  studioMigrations: string,
): Promise<{ ok: true; status: "awaiting_invoke_key" } | { ok: false; step: ProvisionStep; message: string }> {
  const done: ProvisionStep[] = [];
  const mark = async (step: ProvisionStep) => {
    done.push(step);
    await deps.store.updateJobProgress(jobId, step, JSON.stringify(done));
  };

  try {
    await deps.store.setJobRunning(jobId);
    await deps.store.setTenantStatus(tenant.id, "provisioning");

    // 1. D1. Adopt-on-exists makes a re-run safe.
    const db = await deps.cf.createD1(tenantD1Name(tenant.slug));
    await deps.store.setTenantD1(tenant.id, db.uuid);
    await mark("d1_create");

    // 2. Migrations: the SAME migration files the studio ships. Multi-statement in one call is
    //    spike-proven, and the files are CREATE TABLE IF NOT EXISTS, so re-applying is a no-op.
    await deps.cf.queryD1(db.uuid, studioMigrations);
    await mark("d1_migrate");

    // 3. Bucket per tenant (not a prefix): satellite-visible R2 creds must reach ONLY this tenant.
    const bucket = tenantBucketName(tenant.slug);
    await deps.cf.createR2Bucket(bucket);
    await deps.store.setTenantBucket(tenant.id, bucket);
    await mark("r2_bucket");

    // 4. Bucket-scoped creds. Re-minted on every run: we never stored the value, so there is
    //    nothing to reuse. The previous token is revoked first so a retry does not leave a trail of
    //    live grants behind it.
    const previousTokenId = tenant.r2_token_id;
    if (previousTokenId) {
      try {
        await deps.cf.revokeToken(previousTokenId);
      } catch (e) {
        // A stale token that will not revoke must not strand the tenant, but it MUST be visible:
        // it is a live credential we failed to clean up.
        deps.log("r2_token.revoke_failed", { tenant: tenant.id, error: String(e) });
      }
    }
    const token = await deps.cf.mintR2Token(tenantR2TokenName(tenant.slug), bucket, deps.r2PermissionGroupId);
    await deps.store.setTenantR2Token(tenant.id, token.id);
    await mark("r2_token");

    // 5. RunPod (#54). The ONLY step that needs key A, which is why it is a parameter and why its
    //    absence is an honest stop rather than a skip.
    if (!runpodApiKey) {
      return { ok: false, step: "runpod_endpoints", message: "runpod_key_required" };
    }
    const endpoints = await deps.runpod.createEndpoints(runpodApiKey, tenant.slug);
    await deps.store.setTenantEndpoints(tenant.id, JSON.stringify(endpoints));
    await mark("runpod_endpoints");

    // 6. Upload the PUBLISHED studio release, unmodified. No hosted fork exists to drift.
    const built = await deps.bundle.fetch(deps.release);
    let assetsJwt: string | undefined;
    if (built.assets?.length) assetsJwt = await uploadAssets(deps, tenant.slug, built.assets);

    await deps.cf.uploadUserWorker({
      namespace: deps.namespace,
      scriptName: deps.tenantScriptName(tenant.slug),
      mainModule: built.mainModule,
      moduleText: built.moduleText,
      compatibilityDate: built.compatibilityDate,
      compatibilityFlags: built.compatibilityFlags,
      assetsJwt,
      bindings: [
        { type: "d1", name: "DB", id: db.uuid },
        { type: "r2_bucket", name: "R2_RENDERS", bucket_name: bucket },
        { type: "r2_bucket", name: "R2", bucket_name: bucket },
        { type: "plain_text", name: "AUTH_MODE", text: "token" },
        { type: "plain_text", name: "R2_S3_BUCKET", text: bucket },
        // The credential goes straight from the mint into a worker secret. It is never persisted
        // on our side and never returned to any caller.
        { type: "secret_text", name: "R2_S3_ACCESS_KEY_ID", text: token.id },
        { type: "secret_text", name: "R2_S3_SECRET_ACCESS_KEY", text: await sha256Hex(token.value) },
      ],
    });
    await deps.store.setTenantScript(tenant.id, deps.tenantScriptName(tenant.slug), deps.release);
    await mark("wfp_upload");

    // 7. Verify what we actually built, from the API's own view, rather than trusting our writes.
    //    Names only; these endpoints never return values.
    const script = deps.tenantScriptName(tenant.slug);
    const bindings = await deps.cf.getScriptBindings(deps.namespace, script);
    const names = new Set(bindings.map((b) => b.name));
    for (const required of ["DB", "R2_RENDERS", "AUTH_MODE"]) {
      if (!names.has(required)) {
        throw new ProvisionFailure("verify", `tenant worker is missing the ${required} binding after upload`);
      }
    }
    const secrets = await deps.cf.getScriptSecretNames(deps.namespace, script);
    if (!secrets.includes("R2_S3_SECRET_ACCESS_KEY")) {
      throw new ProvisionFailure("verify", "tenant worker is missing its R2 credential after upload");
    }
    await mark("verify");

    // The studio is built but cannot render until key B lands: RunPod will not let us mint that key
    // and it cannot be scoped to endpoints that did not exist a moment ago.
    await deps.store.setTenantStatus(tenant.id, "awaiting_invoke_key");
    await deps.store.finishJob(jobId, "succeeded", null, null);
    return { ok: true, status: "awaiting_invoke_key" };
  } catch (e) {
    const step = e instanceof ProvisionFailure ? e.step : inferStep(done);
    // The REAL error, verbatim. If RunPod says the worker quota is 10 and we need 12, that exact
    // sentence is what the tenant reads.
    const message = e instanceof CfApiError || e instanceof ProvisionFailure ? e.message : String(e);
    deps.log("provision.failed", { tenant: tenant.id, step, message });
    await deps.store.finishJob(jobId, "failed", step, message);
    await deps.store.setTenantStatus(tenant.id, "failed");
    return { ok: false, step, message };
  }
}

const inferStep = (done: ProvisionStep[]): ProvisionStep =>
  PROVISION_STEPS[Math.min(done.length, PROVISION_STEPS.length - 1)];

async function uploadAssets(
  deps: ProvisionDeps,
  slug: string,
  assets: NonNullable<Awaited<ReturnType<StudioBundleSource["fetch"]>>["assets"]>,
): Promise<string | undefined> {
  const script = deps.tenantScriptName(slug);
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const a of assets) manifest[a.path] = { hash: a.hash, size: a.size };

  const session = await deps.cf.createAssetsUploadSession(deps.namespace, script, manifest);
  // No buckets to fill means every asset is already resident in the namespace (WfP dedupes assets
  // by hash ACROSS the namespace, so tenant N+1 ships the same UI for free). The session JWT is
  // then already the completion JWT.
  if (!session.buckets?.length) return session.jwt;

  const byHash = new Map(assets.map((a) => [a.hash, a]));
  let completion: string | undefined = session.jwt;
  for (const bucket of session.buckets) {
    const files = bucket
      .map((hash) => byHash.get(hash))
      .filter((a): a is NonNullable<typeof a> => Boolean(a))
      .map((a) => ({ hash: a.hash, base64: a.base64, contentType: a.contentType }));
    if (!files.length) continue;
    const res = await deps.cf.uploadAssetBucket(session.jwt ?? "", files);
    if (res.jwt) completion = res.jwt;
  }
  return completion;
}

/**
 * Tear a tenant down. Best-effort and ORDERED so that the tenant stops being reachable FIRST:
 * pulling the worker before deleting its data means no request can hit a half-deleted studio.
 * Every failure is collected and reported rather than thrown, because a teardown that stops at the
 * first error leaves the most dangerous leftovers (a live credential) behind.
 */
export async function teardownTenant(
  deps: ProvisionDeps,
  tenant: Tenant,
  opts: { deleteData: boolean },
): Promise<{ ok: boolean; failures: { resource: string; error: string }[] }> {
  const failures: { resource: string; error: string }[] = [];
  const attempt = async (resource: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      failures.push({ resource, error: String(e) });
      deps.log("teardown.failed", { tenant: tenant.id, resource, error: String(e) });
    }
  };

  await attempt("worker", () => deps.cf.deleteUserWorker(deps.namespace, deps.tenantScriptName(tenant.slug)));
  // The credential goes next: an un-revoked token outliving its bucket is an orphaned grant.
  if (tenant.r2_token_id) await attempt("r2_token", () => deps.cf.revokeToken(tenant.r2_token_id!));

  if (opts.deleteData) {
    if (tenant.d1_database_id) await attempt("d1", () => deps.cf.deleteD1(tenant.d1_database_id!));
    if (tenant.r2_bucket_name) await attempt("r2_bucket", () => deps.cf.deleteR2Bucket(tenant.r2_bucket_name!));
  }

  // Their RunPod endpoints are THEIRS. We never touch the tenant's RunPod account beyond what they
  // authorized; de-provision shows them a "delete these on RunPod" checklist instead.
  return { ok: failures.length === 0, failures };
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
