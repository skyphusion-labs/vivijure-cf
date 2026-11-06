"""GET /auth-check (cf#887 option (b)): bearer-gated, does no work. No ffmpeg, no network.

Two guards, each with a mutation it must catch (see the PR body for the runs):

1. BEARER GATE. The route sits behind bearer_middleware like every media route. No bearer and a
   wrong bearer are 401, a misconfigured door (no token, no opt-out) is 503, and only the right
   bearer gets the 200. Caught mutation: exempting /auth-check in bearer_middleware the way /health
   is exempted.
2. NO WORK. A call leaves JOBS untouched and reaches no ffmpeg runner, subprocess, worker thread,
   outbound HTTP session, temp dir or file open. Caught mutation: a handler that does any of those.
   The tripwires are proven live by a positive control first, so a zero means "not called" and not
   "the recorder was never wired".

Run (inside the image, or locally with aiohttp):  python3 test_auth_check.py
"""
import asyncio
import builtins
import os
import subprocess
import sys
import tempfile

from aiohttp.test_utils import TestClient, TestServer

import app
import bearer


def check(name, cond):
    if cond:
        print(f"  ok  {name}")
    else:
        print(f"FAIL  {name}")
        check.failed += 1


check.failed = 0

TOKEN = "auth-check-test-token"
GOOD = {"Authorization": f"Bearer {TOKEN}"}
EXPECTED_VERIFIED = {"ok": True, "serving": True, "bearer": "verified", "liveness_only": True}


async def _client():
    client = TestClient(TestServer(app.app))
    await client.start_server()
    return client


async def _json(r):
    """The body as JSON, or {} when it is not JSON. A mutated handler that crashes answers a text 500;
    that must read as a FAIL line on the guard it broke, not as a traceback that hides which one."""
    try:
        return await r.json()
    except Exception:
        return {}


class Tripwires:
    """Replace every work entry point app.py uses with a recorder that refuses. Installed only for
    the window of one request, so aiohttp's own startup is never inside it."""

    def __init__(self):
        self.calls = []
        self._saved = []

    def _wire(self, owner, attr):
        original = getattr(owner, attr)

        def tripped(*a, **k):
            self.calls.append(f"{getattr(owner, '__name__', owner)}.{attr}")
            raise RuntimeError(f"auth-check did work: {attr}")

        self._saved.append((owner, attr, original))
        setattr(owner, attr, tripped)

    def install(self):
        for owner, attr in (
            (app, "_run"),
            (app, "ClientSession"),
            (app, "guarded_get"),
            (app, "guarded_put"),
            (subprocess, "run"),
            (subprocess, "Popen"),
            (asyncio, "create_subprocess_exec"),
            (asyncio, "to_thread"),
            (tempfile, "mkdtemp"),
            (tempfile, "TemporaryDirectory"),
            (tempfile, "NamedTemporaryFile"),
            (builtins, "open"),
        ):
            self._wire(owner, attr)

    def restore(self):
        while self._saved:
            owner, attr, original = self._saved.pop()
            setattr(owner, attr, original)


async def main():
    keys = (bearer.TOKEN_ENV, bearer.ALLOW_UNAUTH_ENV)
    prev = {k: os.environ.get(k) for k in keys}
    try:
        # The route exists, as GET. A missing add_get would otherwise read as a 404 that a careless
        # caller could take for "not serving".
        gets = [
            r.resource.canonical
            for r in app.app.router.routes()
            if getattr(r, "method", None) == "GET"
        ]
        check("GET /auth-check is registered", "/auth-check" in gets)

        # ---- guard 1: the bearer gate ----
        # This file owns BOTH bearer vars. CI sets the opt-out for the other scripts; left ambient it
        # would turn every 401 below into a 200 and this guard would assert nothing.
        os.environ[bearer.TOKEN_ENV] = TOKEN
        os.environ.pop(bearer.ALLOW_UNAUTH_ENV, None)
        client = await _client()
        try:
            r = await client.get("/auth-check")
            check("armed: no bearer -> 401", r.status == 401)
            check("armed: 401 body is the middleware's", (await _json(r)).get("error") == "unauthorized")
            r = await client.get("/auth-check", headers={"Authorization": "Bearer wrong"})
            check("armed: wrong bearer -> 401", r.status == 401)
            r = await client.get("/auth-check", headers={"Authorization": TOKEN})
            check("armed: token without the Bearer scheme -> 401", r.status == 401)
            r = await client.get("/auth-check", headers=GOOD)
            check("armed: good bearer -> 200", r.status == 200)
            text = await r.text()
            body = await _json(r)
            check("armed: body is exactly the contract", body == EXPECTED_VERIFIED)
            check("armed: body never carries the token", TOKEN not in text)
            r = await client.post("/auth-check", headers=GOOD)
            check("POST /auth-check is not a route (405)", r.status == 405)
        finally:
            await client.close()

        os.environ.pop(bearer.TOKEN_ENV, None)
        os.environ.pop(bearer.ALLOW_UNAUTH_ENV, None)
        client = await _client()
        try:
            r = await client.get("/auth-check", headers=GOOD)
            check("no token, no opt-out: 503, never served", r.status == 503)
        finally:
            await client.close()

        # The explicit loopback opt-out lets the request in with nothing checked, and the body says
        # so. "verified" here would be a readiness green on an open door.
        os.environ[bearer.ALLOW_UNAUTH_ENV] = "true"
        client = await _client()
        try:
            r = await client.get("/auth-check")
            body = await _json(r)
            check("opt-out: 200", r.status == 200)
            check("opt-out: bearer reports disabled, not verified", body.get("bearer") == "disabled")
        finally:
            await client.close()

        # ---- guard 2: no work ----
        os.environ[bearer.TOKEN_ENV] = TOKEN
        os.environ.pop(bearer.ALLOW_UNAUTH_ENV, None)

        # Positive control: the tripwires fire when something does call them.
        wires = Tripwires()
        wires.install()
        try:
            try:
                app._run(["ffmpeg", "-version"])
            except RuntimeError:
                pass
            try:
                open(os.devnull)
            except RuntimeError:
                pass
        finally:
            wires.restore()
        check("POSITIVE CONTROL: tripwires record a call", wires.calls == ["app._run", "builtins.open"])

        client = await _client()
        try:
            jobs_before = dict(app.JOBS)
            wires = Tripwires()
            wires.install()
            try:
                r = await client.get("/auth-check", headers=GOOD)
                status = r.status
                body = await _json(r)
            finally:
                wires.restore()
            check("no work: request still answered 200", status == 200 and body == EXPECTED_VERIFIED)
            check(f"no work: no work entry point reached (got {wires.calls})", wires.calls == [])
            check("no work: JOBS untouched", app.JOBS == jobs_before)
        finally:
            await client.close()
    finally:
        for k, v in prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    if check.failed:
        print(f"{check.failed} failed")
        sys.exit(1)
    print("auth-check: all ok")


if __name__ == "__main__":
    asyncio.run(main())
