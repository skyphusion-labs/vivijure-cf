// WHERE A REPORTER IS SENT, AND WHY THE PANEL CANNOT JUST KNOW IT (control-plane#130).
//
// Enforcement on the hosted tier is REPORT-DRIVEN by ruling: nothing is scanned, so a report from a
// person is the entire detection surface. That makes a findable intake path part of the product.
// The hosted front door now carries one. The studio panel has to carry it too, because the panel is
// where a render is actually seen.
//
// THE CONSTRAINT THAT DECIDES THE DESIGN: this panel is the SAME bundle a self-hoster installs. Our
// abuse address must never ship inside it. We are not the provider for a self-hosted studio, we
// cannot see it and cannot switch it off, so advertising our address there would send a reporter to
// someone who can do nothing about it, which is worse than sending them nowhere.
//
// So the panel hardcodes nothing and branches on nothing. The value is an OPERATOR-SET var and the
// panel projects it, exactly like every other host fact (host.dispatch, host.readonly,
// host.hooks_unavailable). Unset means no field, no link, and no address anywhere in the bundle.
// A self-hoster who wants their OWN contact published sets the same var and the panel shows theirs,
// which is the parity-correct outcome rather than a special case for us.

/** The studio env this reads. Kept narrow so a test cannot accidentally satisfy it with a whole Env. */
export interface AbuseContactEnv {
  ABUSE_REPORT_URL?: string;
}

/**
 * The report destination for this studio, or null when there is none to advertise.
 *
 * REFUSES RATHER THAN PASSES THROUGH. A value that is not an http(s) absolute URL is dropped and
 * logged: `javascript:` and `data:` are the reason (a host-payload string ends up in an href, so a
 * scheme check here is a real boundary, not tidiness), and a relative path is dropped because it
 * would resolve against the STUDIO origin and point a reporter at a page that does not exist there.
 *
 * The refusal is LOUD on the server side on purpose. A silently ignored misconfiguration is how an
 * operator sets a var, sees nothing happen, and concludes the feature is broken; that failure family
 * (a change that looks applied and reaches nobody) is exactly what this cluster keeps producing.
 */
export function abuseReportUrl(env: AbuseContactEnv): string | null {
  const raw = (env.ABUSE_REPORT_URL ?? "").trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn("abuse_report_url ignored: not an absolute URL", { value: raw });
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    console.warn("abuse_report_url ignored: scheme is not http(s)", { scheme: parsed.protocol });
    return null;
  }
  return parsed.toString();
}
