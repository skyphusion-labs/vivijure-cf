"""Bearer gate for the media containers. Vendored byte-for-byte into each container dir.

- **GET /health is always open.** Swarm and Traefik healthchecks depend on it, so closing it would
  break orchestration rather than the auth hole. It exposes no artifact and takes no input.
- **LOCAL_FINISH_TOKEN must be set, or the container REFUSES TO START** (`require_bearer_config`,
  called from each app's factory). Not a warning, not a 503 on first request: a door that starts
  and serves is a door somebody will point a tunnel at.
- **LOCAL_FINISH_ALLOW_UNAUTHENTICATED=true** is the explicit opt-out for a genuinely loopback-only
  deployment. It has to be asked for BY NAME. The insecure state is choosable; it is never the
  default, and "unset" is not a request for it.
- With a token set, every route but /health requires `Authorization: Bearer <token>`. Missing or
  wrong is 401, compared with `hmac.compare_digest` so a length mismatch cannot become a timing
  oracle.

WHY THIS CHANGED (cf#893, GHSA-v8g8-gmcm-22gr). This gate used to pass every request through when
the token was unset, and this docstring justified it: *"That is the current VPC path, which sends no
credential. Arming the token is a later flip."* Those doors moved onto public HTTPS three commits
later the same day, nothing re-armed the gate when the boundary moved, and the later flip never
happened. A fail-open default is defensible behind a private network boundary and is not defensible
on a public hostname -- which is exactly where a self-hoster following compose.yaml plus a tunnel
ends up, having never been told a token existed.

So the premise is not merely stale, it inverted: the comment told a reader the open gate was
deliberate and temporary while it was neither.
"""
import hmac
import os

from aiohttp import web

TOKEN_ENV = "LOCAL_FINISH_TOKEN"
ALLOW_UNAUTH_ENV = "LOCAL_FINISH_ALLOW_UNAUTHENTICATED"


class BearerConfigError(RuntimeError):
    """Raised at STARTUP when neither a token nor an explicit no-auth request is present.

    Its own type, not a bare RuntimeError, so a test can tell "the gate refused" from "something
    else went wrong". An AttributeError from a missing function is not a refusal, and a test that
    accepts any exception cannot tell the difference.
    """


def configured_token() -> str:
    """The token, stripped. Whitespace is not a credential: `TOKEN=" "` is unset with extra steps,
    and a truthiness check on the raw value would accept it."""
    return (os.environ.get(TOKEN_ENV) or "").strip()


def unauthenticated_requested() -> bool:
    """True only for an exact, explicit `true`. Anything else -- unset, empty, `1`, `yes`, a typo --
    is NOT a request to disable authentication. Guessing in the permissive direction here is the
    whole defect this file exists to close."""
    return (os.environ.get(ALLOW_UNAUTH_ENV) or "").strip().lower() == "true"


def require_bearer_config() -> None:
    """Call from the app factory, BEFORE the server binds. Raises unless auth is configured or
    no-auth was explicitly requested by name."""
    if configured_token():
        return
    if unauthenticated_requested():
        print(
            f"WARNING: {ALLOW_UNAUTH_ENV}=true -- this container serves media routes with NO "
            f"authentication. Intended only for a loopback-only deployment. Set {TOKEN_ENV} "
            f"instead if this door is reachable from anywhere else.",
            flush=True,
        )
        return
    raise BearerConfigError(
        f"{TOKEN_ENV} is not set, so this container refuses to start. Set it to a shared secret "
        f"and send it as `Authorization: Bearer <token>`. If this deployment is genuinely "
        f"loopback-only and wants no authentication, request that explicitly with "
        f"{ALLOW_UNAUTH_ENV}=true."
    )


def presented_token(req):
    header = req.headers.get("Authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:]
    return None


@web.middleware
async def bearer_middleware(req: web.Request, handler):
    if req.path == "/health" or req.path.rstrip("/") == "/health":
        return await handler(req)
    expected = configured_token()
    if not expected:
        if unauthenticated_requested():
            return await handler(req)
        # Unreachable when require_bearer_config ran at startup, and deliberately still here: if a
        # future factory forgets that call, this refuses rather than silently reopening the gate.
        # A second line of defense that costs one env read per request.
        return web.json_response(
            {"ok": False, "error": f"server misconfigured: {TOKEN_ENV} is not set"}, status=503
        )
    got = presented_token(req)
    if not got or not hmac.compare_digest(got, expected):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    return await handler(req)
