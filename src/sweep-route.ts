// POST /api/internal/sweep: run the same sweep pass the cron runs, for a deployment that cannot attach a
// cron trigger to this Worker. Without a cron nothing advances a film job nobody is polling, and a parent
// (long) film is never started at all, because the sweep is its only driver.
//
// OFF BY DEFAULT. The route exists only when the SWEEP_TOKEN secret is set, and only for a request that
// presents exactly that token as `Authorization: Bearer <token>`. In every other case routeRequest does not
// treat the request as this route at all: it falls through to normal routing and gets exactly what an
// unknown /api path gets (the auth gate's refusal for a caller with no studio credential, a 404 for one
// with a studio credential). So the route cannot be told apart from an unknown path, and a deployment that
// never sets SWEEP_TOKEN sees no change.
//
// ONE CREDENTIAL. The studio's own bearers never open this route: the auth gate does not run for it, and
// the only comparison is against SWEEP_TOKEN. A SWEEP_TOKEN that EQUALS the operator token or a live
// consumer token is refused outright, because then a studio bearer would also be a sweep bearer. The token
// is read from the Authorization header only, never the cookie, and the route is POST only.

import type { Env } from "./env";
import { constantTimeEqual, namedTokenConsumer } from "./auth-gate";

export const SWEEP_ROUTE_PATH = "/api/internal/sweep";

export async function sweepRouteAuthorized(request: Request, env: Env): Promise<boolean> {
  if (request.method !== "POST") return false;
  const secret = (env.SWEEP_TOKEN || "").trim();
  if (!secret) return false;
  const m = /^Bearer\s+(\S+)$/i.exec((request.headers.get("authorization") || "").trim());
  if (!m) return false;
  if (!(await constantTimeEqual(m[1], secret))) return false;
  const operator = (env.STUDIO_API_TOKEN || "").trim();
  if ((operator && (await constantTimeEqual(secret, operator))) || (await namedTokenConsumer(secret, env)) !== null) {
    // Loud in the log, silent on the wire: the caller still gets the unknown-route answer.
    console.error(JSON.stringify({
      ev: "sweep.token_reused",
      msg: "SWEEP_TOKEN equals a studio API token, so the sweep route is refused. Set a distinct value.",
    }));
    return false;
  }
  return true;
}
