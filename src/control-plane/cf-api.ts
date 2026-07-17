// The Cloudflare REST client the provisioner drives (#53).
//
// Every shape here was live-proven in the #40 spike (issuecomment-4998770527); this is the TS port
// of what the spike did by hand, not a docs reading.
//
// SECRET HYGIENE, load-bearing: this module handles the provisioner token, minted R2 secrets, and
// tenant RunPod keys. NOTHING here ever logs a request body, a header, or a response that could
// carry a credential. Errors carry the API's own message and the status, never the payload that
// produced them. A leaked provisioner token is the whole account.

/** Raised for any non-ok CF API response. Carries CF's OWN error text (honest failures). */
export class CfApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly cfErrors: { code?: number; message: string }[],
  ) {
    // CF's own words, verbatim. If D1 says a database name is taken, the tenant reads exactly that.
    const detail = cfErrors.length ? cfErrors.map((e) => e.message).join("; ") : `HTTP ${status}`;
    super(`${operation}: ${detail}`);
    this.name = "CfApiError";
  }
}

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: { code?: number; message: string }[];
}

const CF_API = "https://api.cloudflare.com/client/v4";

export interface D1Binding {
  type: "d1";
  name: string;
  id: string;
}
export interface R2Binding {
  type: "r2_bucket";
  name: string;
  bucket_name: string;
}
export interface PlainTextBinding {
  type: "plain_text";
  name: string;
  text: string;
}
export interface SecretTextBinding {
  type: "secret_text";
  name: string;
  text: string;
}
export type WorkerBinding = D1Binding | R2Binding | PlainTextBinding | SecretTextBinding;

/** An asset in the upload manifest: the path plus a 32-hex hash and byte size. */
export interface AssetManifestEntry {
  hash: string;
  size: number;
}

export class CfApi {
  constructor(
    private readonly accountId: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    operation: string,
    path: string,
    init: RequestInit = {},
    // Callers pass a body already; this only ever adds auth. Never logged.
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const res = await this.fetchImpl(`${CF_API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...extraHeaders, ...(init.headers as Record<string, string>) },
    });
    let body: CfEnvelope<T> | null = null;
    try {
      body = (await res.json()) as CfEnvelope<T>;
    } catch {
      // A non-JSON body from CF means something is badly wrong; the status is the honest signal.
      throw new CfApiError(operation, res.status, []);
    }
    if (!res.ok || !body.success) throw new CfApiError(operation, res.status, body.errors ?? []);
    return body.result;
  }

  // ---- D1 ----

  /**
   * Idempotent-by-name: if the database already exists, the create 400s and we adopt the existing
   * one instead of failing. That is what makes a resumed job safe to re-run from the top, and it
   * mirrors runpod-provision.py's proven shape.
   */
  async createD1(name: string): Promise<{ uuid: string }> {
    try {
      return await this.call<{ uuid: string }>("d1.create", "/accounts/" + this.accountId + "/d1/database", {
        method: "POST",
        body: JSON.stringify({ name }),
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      if (e instanceof CfApiError) {
        const existing = await this.findD1ByName(name);
        if (existing) return existing;
      }
      throw e;
    }
  }

  async findD1ByName(name: string): Promise<{ uuid: string } | null> {
    const list = await this.call<{ uuid: string; name: string }[]>(
      "d1.list",
      `/accounts/${this.accountId}/d1/database?name=${encodeURIComponent(name)}`,
    );
    const hit = list.find((d) => d.name === name);
    return hit ? { uuid: hit.uuid } : null;
  }

  /** Multi-statement SQL in one call works (spike-proven); statements are reported per-statement. */
  async queryD1(databaseId: string, sql: string): Promise<unknown> {
    return await this.call<unknown>("d1.query", `/accounts/${this.accountId}/d1/database/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql }),
      headers: { "content-type": "application/json" },
    });
  }

  /** The tenant data-export story, free from D1 (spike bonus). Used by de-provision. */
  async exportD1(databaseId: string): Promise<{ signed_url?: string }> {
    return await this.call<{ signed_url?: string }>(
      "d1.export",
      `/accounts/${this.accountId}/d1/database/${databaseId}/export`,
      { method: "POST", body: JSON.stringify({ output_format: "polling" }), headers: { "content-type": "application/json" } },
    );
  }

  async deleteD1(databaseId: string): Promise<void> {
    await this.call<unknown>("d1.delete", `/accounts/${this.accountId}/d1/database/${databaseId}`, {
      method: "DELETE",
    });
  }

  // ---- R2 ----

  /** Idempotent-by-name, same reasoning as createD1: a bucket that exists is adopted, not fatal. */
  async createR2Bucket(name: string): Promise<void> {
    try {
      await this.call<unknown>("r2.createBucket", `/accounts/${this.accountId}/r2/buckets`, {
        method: "POST",
        body: JSON.stringify({ name }),
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      if (e instanceof CfApiError && (await this.r2BucketExists(name))) return;
      throw e;
    }
  }

  async r2BucketExists(name: string): Promise<boolean> {
    try {
      await this.call<unknown>("r2.getBucket", `/accounts/${this.accountId}/r2/buckets/${encodeURIComponent(name)}`);
      return true;
    } catch {
      return false;
    }
  }

  async deleteR2Bucket(name: string): Promise<void> {
    await this.call<unknown>("r2.deleteBucket", `/accounts/${this.accountId}/r2/buckets/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  // ---- account tokens (bucket-scoped R2 creds) ----

  /**
   * Mint a bucket-scoped R2 token.
   *
   * WHY BUCKET-SCOPED AND NOT A PREFIX: the finish satellites carry R2 credentials on their RunPod
   * templates, and in BYO mode those templates live on the TENANT's account where the tenant can
   * read every env var. R2 tokens scope to BUCKETS, not prefixes, so a prefix-in-shared-bucket
   * design would hand every tenant a credential that reads everyone else's renders. One bucket per
   * tenant is forced by that, not chosen for tidiness.
   *
   * The returned VALUE is a secret and is returned to the caller ONLY to be written straight into a
   * worker secret. It is never persisted here, never logged, never put in control-plane D1.
   */
  async mintR2Token(
    name: string,
    bucket: string,
    permissionGroupIds: string[],
  ): Promise<{ id: string; value: string }> {
    return await this.call<{ id: string; value: string }>("tokens.create", `/accounts/${this.accountId}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        policies: [
          {
            effect: "allow",
            // A LIST, not one group: a render both reads and writes its bucket, so the credential
            // needs Bucket Item Read AND Write. Minting write-only produced a token that CF
            // reported as active with exactly the right resources, and which then 401'd on its own
            // bucket -- a credential that looks perfect in the API and does nothing.
            permission_groups: permissionGroupIds.map((id) => ({ id })),
            resources: {
              [`com.cloudflare.edge.r2.bucket.${this.accountId}_default_${bucket}`]: "*",
            },
          },
        ],
      }),
    });
  }

  async revokeToken(tokenId: string): Promise<void> {
    await this.call<unknown>("tokens.delete", `/accounts/${this.accountId}/tokens/${tokenId}`, { method: "DELETE" });
  }

  // ---- Workers for Platforms ----

  /**
   * Upload a user Worker into the dispatch namespace. Multipart: a metadata part naming the main
   * module + bindings, and the module itself as application/javascript+module (spike-proven shape,
   * and the same shape scripts/install-module.ts already uses).
   */
  async uploadUserWorker(args: {
    namespace: string;
    scriptName: string;
    mainModule: string;
    moduleText: string;
    compatibilityDate: string;
    compatibilityFlags?: string[];
    bindings: WorkerBinding[];
    /** Completion JWT from finishAssetsUpload, if the worker ships static assets. */
    assetsJwt?: string;
    assetsConfig?: Record<string, unknown>;
  }): Promise<void> {
    const metadata: Record<string, unknown> = {
      main_module: args.mainModule,
      compatibility_date: args.compatibilityDate,
      bindings: args.bindings,
    };
    if (args.compatibilityFlags?.length) metadata.compatibility_flags = args.compatibilityFlags;
    if (args.assetsJwt) {
      metadata.assets = { jwt: args.assetsJwt, ...(args.assetsConfig ? { config: args.assetsConfig } : {}) };
    }

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append(
      args.mainModule,
      new Blob([args.moduleText], { type: "application/javascript+module" }),
      args.mainModule,
    );

    await this.call<unknown>(
      "wfp.upload",
      `/accounts/${this.accountId}/workers/dispatch/namespaces/${args.namespace}/scripts/${args.scriptName}`,
      { method: "PUT", body: form },
    );
  }

  /**
   * Rotate/install a single secret on a resident script WITHOUT re-uploading the worker
   * (spike-proven). This is the whole key-custody mechanism: the tenant's RunPod key is installed
   * and rotated here and lives nowhere else.
   */
  async putScriptSecret(namespace: string, scriptName: string, name: string, text: string): Promise<void> {
    await this.call<unknown>(
      "wfp.putSecret",
      `/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/secrets`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, text, type: "secret_text" }),
      },
    );
  }

  /** Names only, never values: the honest post-provision verification primitive (spike-proven). */
  async getScriptSecretNames(namespace: string, scriptName: string): Promise<string[]> {
    const res = await this.call<{ name: string }[]>(
      "wfp.getSecrets",
      `/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/secrets`,
    );
    return res.map((s) => s.name);
  }

  async getScriptBindings(namespace: string, scriptName: string): Promise<{ type: string; name: string }[]> {
    return await this.call<{ type: string; name: string }[]>(
      "wfp.getBindings",
      `/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/bindings`,
    );
  }

  async deleteUserWorker(namespace: string, scriptName: string): Promise<void> {
    await this.call<unknown>(
      "wfp.deleteScript",
      `/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}?force=true`,
      { method: "DELETE" },
    );
  }

  // ---- static assets for a user Worker ----
  //
  // NOTE captured from the docs while closing a spike gap: WfP assets are associated with the
  // NAMESPACE, not the individual user Worker, and dedupe by hash. That is fine (and cheap) for us
  // because every tenant ships the SAME published studio UI, and tenants never author assets. It
  // would be a cross-tenant concern the day anything tenant-supplied went through this path.

  async createAssetsUploadSession(
    namespace: string,
    scriptName: string,
    manifest: Record<string, AssetManifestEntry>,
  ): Promise<{ jwt?: string; buckets?: string[][] }> {
    return await this.call<{ jwt?: string; buckets?: string[][] }>(
      "wfp.assetsUploadSession",
      `/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/assets-upload-session`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest }) },
    );
  }

  /**
   * Upload one bucket of asset bodies with the session JWT (NOT the account token: the upload door
   * takes the short-lived JWT, which expires in an hour). Returns the completion JWT once the last
   * bucket lands.
   */
  async uploadAssetBucket(
    sessionJwt: string,
    files: { hash: string; base64: string; contentType: string }[],
  ): Promise<{ jwt?: string }> {
    const form = new FormData();
    for (const f of files) {
      form.append(f.hash, new Blob([f.base64], { type: f.contentType }), f.hash);
    }
    const res = await this.fetchImpl(`${CF_API}/accounts/${this.accountId}/workers/assets/upload?base64=true`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionJwt}` },
      body: form,
    });
    let body: CfEnvelope<{ jwt?: string }> | null = null;
    try {
      body = (await res.json()) as CfEnvelope<{ jwt?: string }>;
    } catch {
      throw new CfApiError("assets.upload", res.status, []);
    }
    if (!res.ok || !body.success) throw new CfApiError("assets.upload", res.status, body.errors ?? []);
    return body.result;
  }
}
