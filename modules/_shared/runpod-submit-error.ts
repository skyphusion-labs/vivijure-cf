// A RunPod /run that is refused must say why, and must say whether trying again can help.
//
// Measured 2026-11-06: three studio keyframes-only renders failed with only "keyframe /run -> 409" in under 2 s
// (film-8ec90c0a, film-8628c1f8, film-a87d1e25). Each came 7 to 25 s after the endpoint was updated to a new
// version (RunPod audit log, xe5d1ivs40ohjo versions 30 and 31), and a film submitted 11 s later went through. So
// a 409 there is a short window, not a bad request. Core read "-> 409" as deterministic and failed the film; the
// body that said why was thrown away.
//
// THE BODY IS NOT ECHOED RAW. The /run request carries the tenant's R2 credential and presigned URLs, and a provider
// that echoes its input would put them in an error the panel shows. So only the body's own `error` or `message`
// string is kept, with any URL and any long token-like run replaced, on one line, capped.

export type SubmitFailureReason = "upstream-unavailable" | "rate-limited";

const MAX_DETAIL = 200;

/** The provider's own reason from a refused /run body, made safe to show. Empty when there is none. */
export function safeSubmitDetail(body: string): string {
  let text = "";
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const v = typeof j.error === "string" ? j.error : typeof j.message === "string" ? j.message : "";
    text = v;
  } catch {
    return ""; // not JSON: nothing structured to trust, so nothing is shown
  }
  text = text
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_DETAIL ? text.slice(0, MAX_DETAIL) + "..." : text;
}

/** Which refusals are worth a later submit. 409 is the endpoint mid-update (measured above); 5xx is the service; 429
 *  is throttling. Everything else is left to core's reading of the status, which treats it as final. */
export function submitFailureReason(status: number): SubmitFailureReason | undefined {
  if (status === 429) return "rate-limited";
  if (status === 409 || (status >= 500 && status <= 599)) return "upstream-unavailable";
  return undefined;
}

/** The failure a module returns for a refused /run: the status, the provider's reason when it gave one, and a declared
 *  fault class core honours over the prose (vivijure-core#291). */
export async function runpodSubmitFailure(
  label: string,
  r: { status: number; text(): Promise<string> },
): Promise<{ ok: false; error: string; reason?: SubmitFailureReason }> {
  let detail = "";
  try {
    detail = safeSubmitDetail(await r.text());
  } catch {
    detail = "";
  }
  const reason = submitFailureReason(r.status);
  const error = `${label} /run -> ${r.status}${detail ? `: ${detail}` : ""}`;
  return reason ? { ok: false, error, reason } : { ok: false, error };
}
