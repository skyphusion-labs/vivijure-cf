// One sweep pass at a time, across every way a pass can start.
//
// A pass is started by the cron (scheduled) or by POST /api/internal/sweep (src/sweep-route.ts) on a
// deployment that cannot attach a cron. Before this lease the cron had NO pass-level guard: a pass that
// ran longer than the cron interval overlapped the next one. The per-row guards stay the correctness
// layer and this does not replace them: core's renders.advance_lease for a film job, and the R2 etag
// compare in saveParent for a parent film. This lease is a cheap pass-level dedupe on top. It matters
// more once an external scheduler can call the route, because nothing bounds how often it calls.
//
// Stored as one R2 object beside the film cron heartbeat. The expiry is read from customMetadata so an
// acquire needs only a HEAD. A takeover is a compare on the etag the HEAD saw, so of two passes that see the
// same free lease only the first write wins. R2's etag is a hash of the CONTENT, and that is safe here: a
// new lease body carries its own expiry, which cannot equal the expiry of a lease that is already free.
//
// FAIL OPEN on a storage error: the pass runs unguarded and says so. Skipping would strand every film
// whose only driver is this pass, and the per-row guards still hold.

import { FILM_PARENT_PREFIX } from "./film-parent";

export const SWEEP_LEASE_KEY = `${FILM_PARENT_PREFIX}sweep-lease.json`;
/** Longer than a normal pass, short enough that a pass killed mid-run costs at most one skipped cron tick. */
export const SWEEP_LEASE_MS = 90_000;

/** "busy": another pass holds the lease. `etag: null`: storage failed, so the pass runs unguarded. */
export type SweepLease = "busy" | { etag: string | null };

type LeaseBucket = Pick<R2Bucket, "head" | "put">;

function leaseBody(until: number): { body: string; meta: Record<string, string> } {
  return { body: JSON.stringify({ until }), meta: { until: String(until) } };
}

export async function acquireSweepLease(bucket: LeaseBucket, now: number): Promise<SweepLease> {
  try {
    const { body, meta } = leaseBody(now + SWEEP_LEASE_MS);
    const head = await bucket.head(SWEEP_LEASE_KEY);
    if (!head) {
      const written = await bucket.put(SWEEP_LEASE_KEY, body, {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: meta,
      });
      return written ? { etag: written.etag } : "busy";
    }
    const heldUntil = Number(head.customMetadata?.until);
    if (Number.isFinite(heldUntil) && heldUntil > now) return "busy";
    const written = await bucket.put(SWEEP_LEASE_KEY, body, {
      onlyIf: { etagMatches: head.etag },
      customMetadata: meta,
    });
    return written ? { etag: written.etag } : "busy";
  } catch (e) {
    console.warn(JSON.stringify({ ev: "sweep.lease_unavailable", reason: String(e), msg: "running the pass unguarded" }));
    return { etag: null };
  }
}

/** Gives the lease back only if it is still ours. A pass that outran SWEEP_LEASE_MS and lost it to a newer
 *  pass leaves that pass's lease alone, because the compare fails. */
export async function releaseSweepLease(bucket: LeaseBucket, etag: string): Promise<void> {
  const { body, meta } = leaseBody(0);
  await bucket.put(SWEEP_LEASE_KEY, body, { onlyIf: { etagMatches: etag }, customMetadata: meta });
}
