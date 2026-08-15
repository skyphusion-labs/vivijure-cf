"""Bearer gate for fleet media containers.

Same contract as the GPU doors (LOCAL_FINISH_TOKEN + Authorization: Bearer):

- GET /health is always open (Traefik and swarm healthchecks).
- If LOCAL_FINISH_TOKEN is unset, the gate is open. That is the current VPC
  path, which sends no credential. Arming the token is a later flip.
- If the token is set, every other route requires it. Missing or wrong is 401.
  hmac.compare_digest so a length-mismatch cannot become a timing oracle.
"""
import hmac
import os

from aiohttp import web

TOKEN_ENV = "LOCAL_FINISH_TOKEN"


def presented_token(req):
    header = req.headers.get("Authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:]
    return None


@web.middleware
async def bearer_middleware(req: web.Request, handler):
    if req.path == "/health" or req.path.rstrip("/") == "/health":
        return await handler(req)
    expected = os.environ.get(TOKEN_ENV) or ""
    if not expected:
        return await handler(req)
    got = presented_token(req)
    if not got or not hmac.compare_digest(got, expected):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    return await handler(req)
