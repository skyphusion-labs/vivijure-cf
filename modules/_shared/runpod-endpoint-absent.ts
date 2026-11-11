// cf#757: a RunPod endpoint that does not exist, told apart from every other refusal.
//
// MEASURED by the lead on 2026-11-09 with a valid key, against an endpoint id that does not exist:
// both POST /v2/<id>/run and GET /v2/<id>/health answer HTTP 404 with the body
//   {"status":404,"title":"Not Found","detail":"endpoint not found"}
// That is the ONLY shape this file recognises. A 404 with any other detail (RunPod's job-level
// `job not found` is one, and it is NOT this) stays a plain refusal, so a guess can never turn into
// a confident "no backend".
//
// NOT ENCODED, on purpose, because nobody measured them: what a bad key gets on a missing endpoint,
// and what GET /status/<job> answers once the endpoint behind a running job is deleted. Add them
// here only with a measurement in this comment.

export const RUNPOD_ENDPOINT_ABSENT_DETAIL = "endpoint not found";

/** True only for RunPod's measured missing-endpoint answer: HTTP 404 and `detail` exactly as above. */
export function runpodEndpointAbsent(status: number, bodyText: string): boolean {
  if (status !== 404) return false;
  try {
    const j = JSON.parse(bodyText) as { detail?: unknown };
    return j !== null && typeof j === "object" && j.detail === RUNPOD_ENDPOINT_ABSENT_DETAIL;
  } catch {
    return false;
  }
}

/**
 * cf#1373: the `endpoint` block a module's `GET /ready?probe=endpoint` reports. OPT-IN: /ready stays
 * zero-network unless a prober asks, so the plane's existing reads keep their latency and failure modes.
 * It NEVER changes `ok`: provisioning decisions do not move on it (agreed with the plane owner's delegate).
 *
 * `present` is true on a 2xx from GET /health, false only on the measured missing-endpoint answer
 * (runpodEndpointAbsent), and null for everything else: an unreadable answer is "could not tell", never a
 * guess. `checked_at` is when the probe ran (ISO, UTC). `error` names why present is null.
 */
export interface EndpointProbe {
  present: boolean | null;
  checked_at: string;
  error?: string;
}

export async function probeEndpointPresence(
  call: (path: string) => Promise<Response>,
  now: () => Date = () => new Date(),
): Promise<EndpointProbe> {
  const checked_at = now().toISOString();
  let res: Response;
  try {
    res = await call("/health");
  } catch (e) {
    return { present: null, checked_at, error: `health unreachable: ${(e as Error).message}` };
  }
  if (res.ok) return { present: true, checked_at };
  const text = await res.text().catch(() => "");
  if (runpodEndpointAbsent(res.status, text)) return { present: false, checked_at };
  return { present: null, checked_at, error: `health -> ${res.status}` };
}
