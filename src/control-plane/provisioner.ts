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
import { randomToken } from "./crypto";
import type { TenantR2Creds } from "./runpod";
import type { ControlPlaneStore, Tenant } from "./store";
import { encryptStudioToken } from "./token-crypto";
import type { TokenMinter } from "./token-minter";
import type { ModuleBundleSource } from "./tenant-modules";
import {
  installTenantModules,
  teardownTenantModules,
  uploadTenantModules,
  verifyTenantModulesInstalled,
  TenantModuleError,
} from "./tenant-modules";

/** The named steps, in order. These strings reach the tenant's screen; keep them legible. */
export const PROVISION_STEPS = [
  "d1_create",
  "d1_migrate",
  "r2_bucket",
  "r2_token",
  "runpod_endpoints",
  "wfp_upload",
  "modules_upload",
  "modules_install",
  "verify",
] as const;
export type ProvisionStep = (typeof PROVISION_STEPS)[number];

/** One of the tenant's 4 RunPod endpoints, as Joan's screens render them. */
export interface TenantEndpoint {
  key: string;
  label: string;
  id: string;
  name: string;
  /** The studio env var this endpoint id is wired into (spec.endpointVar). */
  endpointVar: string;
}

/**
 * The RunPod half of provisioning (#54). Split behind a seam because it is a different lane AND a
 * different trust domain: this is the only part that touches the tenant's transient key.
 */
export interface RunPodProvisioner {
  /**
   * r2 is the REAL minted bucket credential (S3-derived), because the satellite templates carry it
   * and a render reads it. The live e2e once passed placeholders here, which provisioned endpoints
   * whose first render would have failed on R2 auth; the seam takes the credential so the shipping
   * wiring cannot repeat that.
   */
  createEndpoints(runpodApiKey: string, slug: string, r2: TenantR2Creds): Promise<TenantEndpoint[]>;
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
    /**
     * The release's OWN asset handling (manifest assets_config, #78). Consumed verbatim, never
     * re-derived: html_handling="none" + run_worker_first=true are load-bearing in the core (the
     * #374 redirect loop and the post-v0.7.4 unheadered-pages finding), and hardcoding them here
     * would be the exact drift the manifest exists to prevent.
     *
     * `{}` is MEANINGFUL, not missing: it means the release was built with CF's defaults, so the
     * tenant gets CF's defaults. Substituting the core's values for an empty object would re-create
     * the hardcode one layer up.
     */
    assetsConfig?: Record<string, unknown>;
    assets?: { path: string; base64: string; contentType: string; hash: string; size: number }[];
  }>;
}

export interface ProvisionDeps {
  store: ControlPlaneStore;
  cf: CfApi;
  runpod: RunPodProvisioner;
  bundle: StudioBundleSource;
  /** Where tenant MODULE worker bundles come from (cf#99). Same seam as `bundle`, per module. */
  moduleBundle: ModuleBundleSource;
  /**
   * The R2 credential seam. Split out because it is the one leg our API-created provisioner token
   * cannot perform (CF refuses API-created tokens any token-management rights), so it is blocked on
   * a dashboard-created cred while every other leg is live-verified.
   */
  tokenMinter: TokenMinter;
  /** The account S3 endpoint (https://<account>.r2.cloudflarestorage.com) the satellites use. */
  r2Endpoint: string;
  namespace: string;
  /** The shared dispatch namespace tenant MODULE scripts live in (vivijure-tenant-modules). */
  moduleNamespace: string;
  release: string;
  tenantScriptName(slug: string): string;
  /** Base64 KEK for encrypting the tenant STUDIO_API_TOKEN value at rest (token-crypto.ts). */
  kek: string;
  /** Optional per-tenant daily spend ceiling set as SPEND_DAILY_CEILING; null -> studio default. */
  spendDailyCeiling: string | null;
  /**
   * Dispatch a request to the tenant studio over TENANT_DISPATCH, attaching the studio bearer so
   * the AUTH_MODE=token gate passes. Proves the studio SERVES (GET /) and drives its own module
   * install + installed-list routes (cf#99). Generalizes the old probeTenantRoot.
   */
  callTenantStudio(
    scriptName: string,
    init: { method: string; path: string; studioApiToken: string; body?: string },
  ): Promise<{ status: number; text: string }>;
  log(event: string, fields: Record<string, unknown>): void;
}

/** Deterministic, tenant-scoped resource names. Idempotency depends on these being stable. */
export const tenantD1Name = (slug: string) => `vivijure-tenant-${slug}`;
export const tenantBucketName = (slug: string) => `vivijure-tenant-${slug}`;
export const tenantR2TokenName = (slug: string) => `vivijure-tenant-${slug}-r2`;

/**
 * The Workers Rate Limiting namespace the tenant spend limiter binds to. Shared across tenant
 * workers (the limiter keys by client IP, so a shared namespace still throttles per-IP); distinct
 * from the control plane's own CP_RATE_LIMIT namespace. Self-host uses an operator-set id; a fixed
 * platform id is the hosted equivalent.
 */
const SPEND_RATELIMIT_NAMESPACE = "3001";

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
        await deps.tokenMinter.revoke(previousTokenId);
      } catch (e) {
        // A stale token that will not revoke must not strand the tenant, but it MUST be visible:
        // it is a live credential we failed to clean up.
        deps.log("r2_token.revoke_failed", { tenant: tenant.id, error: String(e) });
      }
    }
    const token = await deps.tokenMinter.mintBucketToken(tenantR2TokenName(tenant.slug), bucket);
    // R2 S3 semantics: access key id = token id, secret = SHA-256 hex of the token value. Derived
    // ONCE here and used for both the satellite templates and the worker secret, so they cannot
    // disagree.
    const s3Secret = await sha256Hex(token.value);
    await deps.store.setTenantR2Token(tenant.id, token.id);
    await mark("r2_token");

    // 5. RunPod (#54). The ONLY step that needs key A, which is why it is a parameter and why its
    //    absence is an honest stop rather than a skip.
    if (!runpodApiKey) {
      return { ok: false, step: "runpod_endpoints", message: "runpod_key_required" };
    }
    const endpoints = await deps.runpod.createEndpoints(runpodApiKey, tenant.slug, {
      endpoint: deps.r2Endpoint,
      accessKeyId: token.id,
      secretAccessKey: s3Secret,
      bucket,
    });
    await deps.store.setTenantEndpoints(tenant.id, JSON.stringify(endpoints));
    await mark("runpod_endpoints");

    // 6. Upload the PUBLISHED studio release, unmodified. No hosted fork exists to drift.
    const built = await deps.bundle.fetch(deps.release);
    let assetsJwt: string | undefined;
    if (built.assets?.length) assetsJwt = await uploadAssets(deps, tenant.slug, built.assets);

    // The tenant's studio API token. Minted here, set as the tenant-studio secret (satisfying its
    // AUTH_MODE=token fail-closed gate), and ALSO persisted control-plane-side (encrypted) because
    // the dispatcher injects it for the owner's browser (auth ruling 2026-07-18). It is the one
    // credential stored as a VALUE; token-crypto encrypts it under STUDIO_TOKEN_KEK before D1.
    const studioApiToken = randomToken();

    // Each created endpoint carries the studio env var its id belongs in (spec.endpointVar); the
    // studio cannot dispatch a render without these. The mapping is DATA from the provision plan, so
    // adding a service is a plan entry, not an edit here.
    const endpointBindings = endpoints.map((e) => ({ type: "plain_text" as const, name: e.endpointVar, text: e.id }));

    await deps.cf.uploadUserWorker({
      namespace: deps.namespace,
      scriptName: deps.tenantScriptName(tenant.slug),
      mainModule: built.mainModule,
      moduleText: built.moduleText,
      compatibilityDate: built.compatibilityDate,
      compatibilityFlags: built.compatibilityFlags,
      assetsJwt,
      // The release's own asset handling, verbatim. Without this a tenant got CF defaults while a
      // self-hoster running the SAME release got html_handling="none" -- a blank page at the
      // tenant's studio root, hosted-only, on identical code (#77/#78).
      assetsConfig: built.assetsConfig,
      bindings: [
        // env.ASSETS must be DECLARED for the studio to serve its static UI; without it env.ASSETS
        // is undefined and asset serving throws 1101 on every static path (hosted-only, #40 burn).
        { type: "assets", name: "ASSETS" },
        // MODULE_DISPATCH -> the shared tenant-modules namespace: the studio reaches its own
        // module workers via env.MODULE_DISPATCH.get(script) (cf#99). This is UPLOAD METADATA, not
        // studio code, so the studio bytes stay byte-identical to self-host (parity). A WfP user
        // worker carrying a dispatch_namespace binding was live-proven in the cf#99 step-1 probe.
        { type: "dispatch_namespace", name: "MODULE_DISPATCH", namespace: deps.moduleNamespace },
        { type: "d1", name: "DB", id: db.uuid },
        { type: "r2_bucket", name: "R2_RENDERS", bucket_name: bucket },
        { type: "r2_bucket", name: "R2", bucket_name: bucket },
        { type: "plain_text", name: "AUTH_MODE", text: "token" },
        { type: "plain_text", name: "R2_S3_BUCKET", text: bucket },
        // The 4 RunPod endpoint ids the studio renders against.
        ...endpointBindings,
        // The credential goes straight from the mint into a worker secret. It is never persisted
        // on our side and never returned to any caller.
        { type: "secret_text", name: "R2_S3_ACCESS_KEY_ID", text: token.id },
        { type: "secret_text", name: "R2_S3_SECRET_ACCESS_KEY", text: s3Secret },
        // AUTH_MODE=token requires this; the dispatcher injects it for the owner and the studio
        // fail-closed-denies everyone else.
        { type: "secret_text", name: "STUDIO_API_TOKEN", text: studioApiToken },
        // The studio fail-CLOSES renders when SPEND_RATE_LIMITER is unbound; bind it so the tenant
        // can render, matching self-host's posture exactly (30 req / 60s, fail-closed default).
        {
          type: "ratelimit",
          name: "SPEND_RATE_LIMITER",
          namespace_id: SPEND_RATELIMIT_NAMESPACE,
          simple: { limit: 30, period: 60 },
        },
        // Per-tenant daily spend ceiling (the primary cost cap, DB-enforced fail-closed). Always set
        // -- a hosted tenant without a ceiling has no cost bound. Operator-tunable via env.
        ...(deps.spendDailyCeiling
          ? [{ type: "plain_text" as const, name: "SPEND_DAILY_CEILING", text: deps.spendDailyCeiling }]
          : []),
      ],
    });
    await deps.store.setTenantScript(tenant.id, deps.tenantScriptName(tenant.slug), deps.release);
    // Persist the token VALUE, encrypted, so the dispatcher can inject it. Never plaintext at rest.
    await deps.store.setTenantStudioToken(tenant.id, await encryptStudioToken(deps.kek, studioApiToken));
    await mark("wfp_upload");

    // 7. Upload the tenant MODULE scripts (cf#99) into the shared modules namespace, each carrying
    //    its endpoint id. Key B is NOT bound yet -- it lands in installInvokeKey, alongside the
    //    studio. The studio (with its MODULE_DISPATCH binding) is already up, so the install pass
    //    below can reach these. Idempotent-by-name (adopt-on-exists), like every other step.
    await uploadTenantModules(deps, tenant.id, endpoints);
    await mark("modules_upload");

    // 8. Install each module through the studio's OWN conformance-gated route (cf#99): the studio
    //    runs the live suite against the resident script via its now-bound MODULE_DISPATCH and
    //    seeds installed_modules in the tenant D1. No install logic is duplicated here.
    await installTenantModules(deps, tenant.id, deps.tenantScriptName(tenant.slug), studioApiToken);
    await mark("modules_install");

    // 7. Verify what we actually built, from the API's own view, rather than trusting our writes.
    //    Names only; these endpoints never return values.
    const script = deps.tenantScriptName(tenant.slug);
    const bindings = await deps.cf.getScriptBindings(deps.namespace, script);
    const names = new Set(bindings.map((b) => b.name));
    const requiredBindings = ["DB", "R2_RENDERS", "AUTH_MODE", "ASSETS", "SPEND_RATE_LIMITER", ...endpoints.map((e) => e.endpointVar)];
    for (const required of requiredBindings) {
      if (!names.has(required)) {
        throw new ProvisionFailure("verify", `tenant worker is missing the ${required} binding after upload`);
      }
    }
    const secrets = await deps.cf.getScriptSecretNames(deps.namespace, script);
    for (const required of ["R2_S3_SECRET_ACCESS_KEY", "STUDIO_API_TOKEN"]) {
      if (!secrets.includes(required)) {
        throw new ProvisionFailure("verify", `tenant worker is missing the ${required} secret after upload`);
      }
    }
    // SERVING, not just storage: a binding census green-lit the first live provision, which then
    // 1101'd at the studio root because env.ASSETS was undefined. Dispatch a real request to the
    // worker root and require it does not 5xx.
    const probe = await deps.callTenantStudio(script, { method: "GET", path: "/", studioApiToken });
    if (probe.status >= 500) {
      throw new ProvisionFailure("verify", `tenant studio root returned ${probe.status}; the worker is not serving`);
    }
    // Module half (cf#99): the studio must report a NON-EMPTY installed set, or discovery is dark
    // and a render 503s honestly. The moving-pixels gate (render past discovery) needs key B and
    // is the out-of-band release gate; this proves the bridge exists.
    const installedModules = await verifyTenantModulesInstalled(deps, script, studioApiToken);
    deps.log("provision.modules_installed", { tenant: tenant.id, modules: installedModules });
    await mark("verify");

    // The studio is built but cannot render until key B lands: RunPod will not let us mint that key
    // and it cannot be scoped to endpoints that did not exist a moment ago.
    await deps.store.setTenantStatus(tenant.id, "awaiting_invoke_key");
    await deps.store.finishJob(jobId, "succeeded", null, null);
    return { ok: true, status: "awaiting_invoke_key" };
  } catch (e) {
    const step =
      e instanceof ProvisionFailure ? e.step : e instanceof TenantModuleError ? e.step : inferStep(done);
    // The REAL error, verbatim. If RunPod says the worker quota is 10 and we need 12, that exact
    // sentence is what the tenant reads.
    const message =
      e instanceof CfApiError || e instanceof ProvisionFailure || e instanceof TenantModuleError ? e.message : String(e);
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
  // Module scripts next (cf#99): the studio (discovery) is already gone, so sweeping the tenant's
  // module scripts cannot tear a /poll out from under a live studio. Prefix sweep + census; every
  // failure is surfaced (a live-configured module worker is exactly what must not be left behind).
  const moduleTeardown = await teardownTenantModules(deps, tenant.id);
  for (const f of moduleTeardown.failures) failures.push(f);
  // The credential goes next: an un-revoked token outliving its bucket is an orphaned grant.
  if (tenant.r2_token_id) await attempt("r2_token", () => deps.tokenMinter.revoke(tenant.r2_token_id!));

  if (opts.deleteData) {
    if (tenant.d1_database_id) await attempt("d1", () => deps.cf.deleteD1(tenant.d1_database_id!));
    // KNOWN, LIVE-PROVEN CONSTRAINT: R2 refuses to delete a NON-EMPTY bucket, and R2's REST API has
    // no object-list/delete endpoint at all (404) -- emptying a bucket only goes through the S3 API.
    // So this call SUCCEEDS only for a tenant that never rendered, and for everyone else it fails
    // with CF's own "bucket is not empty". That failure is REPORTED, never swallowed: the caller
    // gets it in `failures` and the tenant's data is still there, which is the safe direction to
    // fail. Emptying-then-deleting needs an S3 client here (mint a bucket cred, ListObjectsV2 +
    // DeleteObjects, delete, revoke) and is tracked as #53 follow-up rather than faked.
    // Caught on real R2; the unit fake said delete always works.
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
