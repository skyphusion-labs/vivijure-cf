// local-gpu backend access: the Env shape, secret resolution, the backend URL + token, and the
// duration-grid relay (#707). A leaf module (vivijure-cf#1308): a Worker entry may export only
// classes and its default handler (cf#1244), so these helpers live here and the entry imports them.
import type { DurationGridDecl } from "./contract";
import { readDurationGrid, normalizeBackendUrl } from "./i2v";

export interface Env {
  // The base URL of the user's local backend (a Cloudflare tunnel hostname terminating at the homelab
  // box), e.g. "https://render.myhomelab.example". Kept a secret: it is the only network handle to the
  // box, and a leaked URL is an unauthenticated GPU-spend / DoS trigger (the same #38 discipline that
  // keeps the RunPod endpoint id a secret).
  LOCAL_BACKEND_URL: SecretsStoreSecret;
  // Optional bearer token the local server checks (a shared secret minted by the homelabber). The
  // service-binding trust boundary is the primary auth (this module has no public surface), but a
  // tunnel origin is reachable if its hostname leaks, so the token is defense in depth. Absent => the
  // body still submits; the server may run open on a trusted LAN tunnel.
  LOCAL_BACKEND_TOKEN?: SecretsStoreSecret;
}

// --- duration-grid relay (#707) ------------------------------------------------------------------
//
// The door DECLARES its fixed duration grid (pinned fps + per-tier frame caps) on /health; this
// module RELAYS it in the manifest so core preflight can warn about duration clamping at storyboard
// time. Best-effort with a short timeout and an in-isolate cache (positive AND negative results, so
// a down door is not re-probed on every manifest fetch and discovery never hangs on it). On any
// failure the manifest simply omits the field: absence = no declared constraint, never fabricated.
const GRID_CACHE_TTL_MS = 5 * 60_000;
const GRID_FETCH_TIMEOUT_MS = 1_500;
let gridCache: { at: number; grid: DurationGridDecl | null } | null = null;

/** Test hook: drop the in-isolate grid cache. */
export function _resetGridCache(): void {
  gridCache = null;
}

export async function doorDurationGrid(
  env: Env,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<DurationGridDecl | null> {
  if (gridCache && nowMs - gridCache.at < GRID_CACHE_TTL_MS) return gridCache.grid;
  let grid: DurationGridDecl | null = null;
  try {
    const { baseUrl, token } = await backendCfg(env);
    if (baseUrl) {
      const r = await fetcher(baseUrl + "/health", {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(GRID_FETCH_TIMEOUT_MS),
      });
      if (r.ok) grid = readDurationGrid(((await r.json()) as { duration_grid?: unknown }).duration_grid);
    }
  } catch {
    // down / slow / non-JSON door: omit the field this TTL window; the manifest stays honest.
  }
  gridCache = { at: nowMs, grid };
  return grid;
}

/** Resolve a Secrets Store binding (production) or a plain string (tests / local dev) to its value. */
export async function secretValue(
  name: "LOCAL_BACKEND_URL" | "LOCAL_BACKEND_TOKEN",
  s: SecretsStoreSecret | string | undefined,
): Promise<{ value: string; error?: string }> {
  if (typeof s === "string") return { value: s };
  if (!s) return { value: "" };
  try {
    return { value: await s.get() };
  } catch (e) {
    const error = `local-gpu: ${name} secret read failed: ${(e as Error).message}`;
    console.warn(error);
    return { value: "", error };
  }
}

/** Resolve the backend URL + optional token once per request. The URL is normalized without a trailing
 *  slash so the path joins below are unambiguous. */
export async function backendCfg(env: Env): Promise<{ baseUrl: string; token: string; urlError?: string }> {
  const [rawUrl, token] = await Promise.all([
    secretValue("LOCAL_BACKEND_URL", env.LOCAL_BACKEND_URL),
    secretValue("LOCAL_BACKEND_TOKEN", env.LOCAL_BACKEND_TOKEN),
  ]);
  const baseUrl = normalizeBackendUrl(rawUrl.value);
  const readError = rawUrl.error ?? token.error;
  return {
    baseUrl: readError ? "" : (baseUrl ?? ""),
    token: readError ? "" : token.value,
    urlError: readError ?? (baseUrl ? undefined : "local-gpu: LOCAL_BACKEND_URL must be an absolute http(s) URL"),
  };
}

/** Auth header for the local server, when a token is configured. */
export function authHeaders(token: string): Record<string, string> {
  return token ? { authorization: "Bearer " + token } : {};
}
