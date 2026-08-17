// Install-path manifest fetch. Mirrors vivijure-core readManifest timeout+retry
// (registry.ts: MANIFEST_READ_TIMEOUT_MS / ATTEMPTS / isRetryableManifestStatus)
// but this site cannot call readManifest:
//   * the install row stores the RAW text that passed the gate, so the bytes
//     must not be re-serialized
//   * an operator POST /install must fail loud, not skip the module (discovery
//     returns null; that is the wrong contract here)
// cf#600.

export const MANIFEST_READ_TIMEOUT_MS = 3000;
export const MANIFEST_READ_ATTEMPTS = 3;
export const MANIFEST_RETRY_BASE_MS = 120;

export type ManifestFetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

/** A non-2xx manifest status worth retrying (the module is up but momentarily unhappy / warming). A
 *  4xx is a real, stable error (bad route / auth) -- do not retry. */
function isRetryableManifestStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export class InstallManifestError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "InstallManifestError";
    this.status = status;
  }
}

export async function fetchInstallManifestText(fetcher: ManifestFetcher): Promise<string> {
  let lastReason = "";
  for (let attempt = 0; attempt < MANIFEST_READ_ATTEMPTS; attempt++) {
    const lastAttempt = attempt === MANIFEST_READ_ATTEMPTS - 1;
    try {
      const res = await fetcher.fetch("https://module/module.json", {
        signal: AbortSignal.timeout(MANIFEST_READ_TIMEOUT_MS),
      });
      if (!res.ok) {
        lastReason = `GET /module.json -> ${res.status}`;
        if (isRetryableManifestStatus(res.status) && !lastAttempt) {
          await new Promise((r) => setTimeout(r, MANIFEST_RETRY_BASE_MS * (attempt + 1)));
          continue;
        }
        throw new InstallManifestError(lastReason, res.status);
      }
      return await res.text();
    } catch (e) {
      if (e instanceof InstallManifestError) throw e;
      lastReason = (e as Error).message;
      if (!lastAttempt) {
        await new Promise((r) => setTimeout(r, MANIFEST_RETRY_BASE_MS * (attempt + 1)));
        continue;
      }
    }
  }
  throw new InstallManifestError(
    `module unreachable after ${MANIFEST_READ_ATTEMPTS} attempts (${lastReason})`,
  );
}
