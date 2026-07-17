// RunPod endpoint provisioning (#54): the TS port of scripts/runpod-provision.py's PROVEN shapes.
//
// The python script stays untouched (its DEFAULT_IMAGE_TAG=0.4.4 is a known footgun, frozen by
// ruling). This is a port of the shapes, not of the script: the pin here is explicit config,
// reviewed at release (Q4 golden-gate), and nothing is pinned until both panels are golden.
//
// TWO-KEY CUSTODY (binding): the key passed in here is KEY A -- the tenant's transient, graphql
// Read/Write key. It is used ONCE, to create these endpoints, and is never stored anywhere: not in
// D1, not in a log, not on the tenant's studio. What the studio eventually stores is KEY B, an
// invoke-only key scoped to exactly the endpoints created here, which the tenant must mint in the
// RunPod console AFTER these exist (RunPod has no key-creation API, and a key cannot be scoped to
// endpoints that do not exist yet -- which is what forces two-phase onboarding).

const RUNPOD_API = "https://rest.runpod.io/v1";

/** GPU classes for the render backend. Same-class (sm_90+) only; see runpod-provision.py section 4. */
const BACKEND_GPUS = ["NVIDIA H200", "NVIDIA B200"];
/** The finish satellites are CPU-light GPU work; RTX 6000 Pro class, as live-verified 2026-07-15. */
const SATELLITE_GPUS = ["NVIDIA RTX 6000 Ada Generation", "NVIDIA L40S"];

export interface PlannedEndpoint {
  /** Stable key the UI and the studio secrets use. */
  key: "backend" | "upscale" | "lipsync" | "audio-upscale";
  label: string;
  imageRepo: string;
  /** The pinned release tag. Explicit config, reviewed at release; NOT the python default. */
  tag: string;
  /**
   * Pinned EXPLICITLY on every endpoint, never left to RunPod's default of 3.
   * Why it matters: the quota is ACCOUNT-WIDE and enforced at CONFIG time against the sum of
   * workersMax across all endpoints (#60). Four endpoints at the default 3 = 12, which fails at
   * create time on the later endpoints. This layout sums to 5 and therefore fits any observed tier.
   */
  maxWorkers: number;
  gpuTypeIds: string[];
  /** The studio secret that carries this endpoint's id. */
  endpointVar: string;
}

/**
 * THE PROVISIONING PLAN, as DATA.
 *
 * Joan's onboarding renders from this rather than hardcoding a list (the registry-projection rule),
 * so what the tenant is shown is what actually gets built. 2+1+1+1 = 5 workers.
 */
export const PROVISION_PLAN: PlannedEndpoint[] = [
  {
    key: "backend",
    label: "Render (keyframes, video, cast LoRA training)",
    imageRepo: "vivijure-backend",
    tag: "1.0.2",
    maxWorkers: 2,
    gpuTypeIds: BACKEND_GPUS,
    endpointVar: "RUNPOD_ENDPOINT_ID",
  },
  {
    key: "upscale",
    label: "Video upscale",
    imageRepo: "vivijure-upscale",
    tag: "0.2.7",
    maxWorkers: 1,
    gpuTypeIds: SATELLITE_GPUS,
    endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID",
  },
  {
    key: "lipsync",
    label: "Lip sync",
    imageRepo: "vivijure-musetalk",
    tag: "0.1.0",
    maxWorkers: 1,
    gpuTypeIds: SATELLITE_GPUS,
    endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID",
  },
  {
    key: "audio-upscale",
    label: "Audio upscale",
    imageRepo: "vivijure-audio-upscale",
    tag: "0.1.0",
    maxWorkers: 1,
    gpuTypeIds: SATELLITE_GPUS,
    endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID",
  },
];

export const planWorkerTotal = (plan: PlannedEndpoint[] = PROVISION_PLAN): number =>
  plan.reduce((n, e) => n + e.maxWorkers, 0);

export interface TenantR2Creds {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * Template env, HANDLER-side names (runpod-provision.py finding F17).
 *
 * The asymmetry is real and load-bearing, not a typo: satellites read/write R2 directly and require
 * R2_ENDPOINT_URL, while the backend requires R2_ENDPOINT (+ HF_HUB_OFFLINE). Getting this wrong
 * does not fail at provision; it fails at the tenant's FIRST FULL RENDER with an R2-mode error
 * (finding F10), which is the worst possible time to find out.
 */
export function templateEnv(key: PlannedEndpoint["key"], r2: TenantR2Creds): Record<string, string> {
  if (key === "backend") {
    return {
      R2_ACCESS_KEY_ID: r2.accessKeyId,
      R2_SECRET_ACCESS_KEY: r2.secretAccessKey,
      R2_BUCKET: r2.bucket,
      R2_ENDPOINT: r2.endpoint,
      HF_HUB_OFFLINE: "1",
    };
  }
  return {
    R2_ENDPOINT_URL: r2.endpoint,
    R2_ACCESS_KEY_ID: r2.accessKeyId,
    R2_SECRET_ACCESS_KEY: r2.secretAccessKey,
    R2_BUCKET: r2.bucket,
  };
}

export class RunPodError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${operation}: ${detail}`);
    this.name = "RunPodError";
  }
}

/** What the account's REAL quota is, read from RunPod itself rather than from the docs. */
export interface QuotaReading {
  /** The account-wide worker quota, or null when RunPod did not tell us. */
  quota: number | null;
  /** The largest workersMax this endpoint could take right now, when RunPod said so. */
  atMost: number | null;
  /** True when the plan fits. */
  fits: boolean;
  /** RunPod's own sentence, for honest surfacing. */
  raw?: string;
}

/**
 * Parse RunPod's quota validation error.
 *
 * This is the ONLY reliable source for the account's quota: it is not exposed on any GraphQL field
 * and introspection is disabled (#60). The published balance table is STALE -- a $50-funded account
 * was observed at quota 10, where the table says 5 -- so the table is never trusted. The error text
 * is deterministic and machine-parseable:
 *
 *   "Max workers across all endpoints will exceed your worker quota of 10. Reduce the max workers
 *    for other endpoints or lower the max worker count for this endpoint to at most 9"
 */
export function parseQuotaError(message: string): { quota: number | null; atMost: number | null } {
  const quota = /worker quota of (\d+)/i.exec(message);
  const atMost = /at most (\d+)/i.exec(message);
  return {
    quota: quota ? Number(quota[1]) : null,
    atMost: atMost ? Number(atMost[1]) : null,
  };
}

export class RunPodClient {
  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(operation: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${RUNPOD_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      // RunPod's own words, verbatim: the quota sentence in particular has to survive to the tenant.
      throw new RunPodError(operation, res.status, text.slice(0, 500));
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Endpoint list. Also the account-identity check: never create against the wrong account. */
  async listEndpoints(): Promise<{ id: string; name: string; workersMax?: number }[]> {
    const res = await this.call<unknown>("endpoints.list", "GET", "/endpoints");
    return normalizeList(res, "endpoints");
  }

  async listTemplates(): Promise<{ id: string; name: string }[]> {
    const res = await this.call<unknown>("templates.list", "GET", "/templates");
    return normalizeList(res, "templates");
  }

  async createTemplate(name: string, imageName: string, env: Record<string, string>, diskGb = 20) {
    return await this.call<{ id: string }>("templates.create", "POST", "/templates", {
      name,
      imageName,
      isServerless: true,
      containerDiskInGb: diskGb,
      env,
    });
  }

  async createEndpoint(args: {
    name: string;
    templateId: string;
    gpuTypeIds: string[];
    workersMax: number;
    idleTimeout?: number;
  }) {
    return await this.call<{ id: string }>("endpoints.create", "POST", "/endpoints", {
      name: args.name,
      templateId: args.templateId,
      computeType: "GPU",
      gpuTypeIds: args.gpuTypeIds,
      gpuCount: 1,
      // Scale-to-zero: idle costs nothing. The whole GPU-rationing thesis in one field.
      workersMin: 0,
      workersMax: args.workersMax,
      idleTimeout: args.idleTimeout ?? 5,
      scalerType: "QUEUE_DELAY",
      scalerValue: 4,
    });
  }

  async deleteEndpoint(id: string): Promise<void> {
    await this.call<unknown>("endpoints.delete", "DELETE", `/endpoints/${id}`);
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.call<unknown>("templates.delete", "DELETE", `/templates/${id}`);
  }

  /** Workers for one endpoint. Teardown verification lists WORKERS, not just endpoints. */
  async listWorkers(endpointId: string): Promise<unknown[]> {
    const res = await this.call<unknown>("workers.list", "GET", `/endpoints/${endpointId}/workers`);
    return Array.isArray(res) ? res : normalizeList(res, "workers");
  }
}

/** RunPod's list payloads vary in shape; accept both the bare array and the wrapped forms. */
function normalizeList<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const wrapped = (payload as Record<string, unknown>)[key];
    if (Array.isArray(wrapped)) return wrapped as T[];
    const data = (payload as Record<string, unknown>).data;
    if (Array.isArray(data)) return data as T[];
  }
  return [];
}

/**
 * Quota preflight: does this plan fit on this account, and if not, say exactly why.
 *
 * Deliberately attempt-and-read rather than compute-and-hope: we ask RunPod for something we know
 * the quota shape of, and read the REAL numbers out of its refusal. Trusting the docs table here is
 * how you ship a provisioner that breaks on the accounts it was supposed to serve.
 */
export async function preflightQuota(
  client: RunPodClient,
  plan: PlannedEndpoint[] = PROVISION_PLAN,
): Promise<QuotaReading> {
  const needed = planWorkerTotal(plan);
  const existing = await client.listEndpoints();
  const existingSum = existing.reduce((n, e) => n + (e.workersMax ?? 0), 0);

  // Probe with a deliberately impossible workersMax so RunPod tells us the real quota in its
  // refusal. Nothing is created: the request is rejected at validation, before any resource exists.
  try {
    await client.createEndpoint({
      name: `vivijure-quota-probe-${Date.now().toString(36)}`,
      templateId: "quota-probe-not-a-real-template",
      gpuTypeIds: ["NVIDIA H200"],
      workersMax: 9999,
    });
    // Should not happen; if it ever does, the probe created nothing usable but we must not claim a
    // reading we do not have.
    return { quota: null, atMost: null, fits: existingSum + needed <= 9999 };
  } catch (e) {
    const raw = e instanceof RunPodError ? e.detail : String(e);
    const { quota, atMost } = parseQuotaError(raw);
    if (quota === null) {
      // RunPod refused for some OTHER reason (a bad template id will do it). We learned nothing
      // about the quota, and saying "fits" here would be a guess dressed as a fact.
      return { quota: null, atMost: null, fits: false, raw };
    }
    return { quota, atMost, fits: existingSum + needed <= quota, raw };
  }
}

export function quotaGuidance(reading: QuotaReading, plan: PlannedEndpoint[] = PROVISION_PLAN): string {
  const needed = planWorkerTotal(plan);
  if (reading.fits) return `Your RunPod account has room for all ${plan.length} endpoints.`;
  if (reading.quota === null) {
    return "We could not read your RunPod worker quota, so we will not guess. Nothing was created.";
  }
  return (
    `Your RunPod account's worker quota is ${reading.quota}, and this studio needs ${needed} ` +
    "workers across 4 endpoints. Free up workers on your existing endpoints, or ask RunPod support " +
    "to raise the quota, then try again. Nothing was created."
  );
}

/** Deterministic per-tenant names. Idempotency (reuse-by-name) depends on these being stable. */
export const tenantEndpointName = (slug: string, key: string) => `vivijure-${slug}-${key}`;

export interface CreatedEndpoint {
  key: string;
  label: string;
  id: string;
  name: string;
}

/**
 * Create the tenant's 4 endpoints with THEIR key. Idempotent by name, exactly like
 * runpod-provision.py: an existing template/endpoint is REUSED, not duplicated, so a retry after a
 * partial failure does not litter the tenant's account with orphans.
 *
 * The key is a parameter and stays one: it is never captured in a field, never logged, never stored.
 */
export async function createTenantEndpoints(
  runpodApiKey: string,
  slug: string,
  r2: TenantR2Creds,
  plan: PlannedEndpoint[] = PROVISION_PLAN,
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedEndpoint[]> {
  const client = new RunPodClient(runpodApiKey, fetchImpl);

  // Fit-or-fail BEFORE creating anything: a half-provisioned RunPod account is the tenant's mess to
  // clean up, on their bill, so we refuse early with RunPod's real numbers instead of discovering
  // the wall on endpoint 3 of 4.
  const quota = await preflightQuota(client, plan);
  if (!quota.fits) throw new RunPodError("quota.preflight", 400, quotaGuidance(quota, plan));

  const [templates, endpoints] = await Promise.all([client.listTemplates(), client.listEndpoints()]);
  const created: CreatedEndpoint[] = [];

  for (const spec of plan) {
    const name = tenantEndpointName(slug, spec.key);

    const existingEndpoint = endpoints.find((e) => e.name === name);
    if (existingEndpoint) {
      created.push({ key: spec.key, label: spec.label, id: existingEndpoint.id, name });
      continue;
    }

    const existingTemplate = templates.find((t) => t.name === name);
    const templateId =
      existingTemplate?.id ??
      (
        await client.createTemplate(
          name,
          `ghcr.io/skyphusion-labs/${spec.imageRepo}:${spec.tag}`,
          templateEnv(spec.key, r2),
        )
      ).id;

    const endpoint = await client.createEndpoint({
      name,
      templateId,
      gpuTypeIds: spec.gpuTypeIds,
      // ALWAYS explicit. RunPod's default of 3 x 4 endpoints = 12 breaks provisioning outright.
      workersMax: spec.maxWorkers,
    });
    created.push({ key: spec.key, label: spec.label, id: endpoint.id, name });
  }

  return created;
}
