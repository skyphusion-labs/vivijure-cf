"""Bearer gate tests. No ffmpeg, no network.

Run (inside the image, or locally with aiohttp):  python3 test_bearer.py
"""
import asyncio
import os
import sys

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


async def _client():
    client = TestClient(TestServer(app.app))
    await client.start_server()
    return client


async def main():
    prev = os.environ.get(bearer.TOKEN_ENV)
    # cf#893: control BOTH bearer vars, not just the token. The CI step that runs these scripts sets
    # LOCAL_FINISH_ALLOW_UNAUTHENTICATED so the other container tests can drive routes without
    # credentials; leaving it ambient here would turn this file's fail-closed case into a
    # pass-through and it would pass while asserting nothing. A test about auth configuration has to
    # own its auth configuration.
    prev_allow = os.environ.get(bearer.ALLOW_UNAUTH_ENV)
    try:
        os.environ.pop(bearer.TOKEN_ENV, None)
        os.environ.pop(bearer.ALLOW_UNAUTH_ENV, None)
        client = await _client()
        try:
            r = await client.get("/health")
            # /health stays open with no credential, always. Swarm and Traefik healthchecks depend
            # on it, so closing it would break orchestration rather than the auth hole.
            check("unset token: /health 200", r.status == 200)
            r = await client.post("/finish", json={})
            # cf#893: this case used to assert `r.status != 401` under the label "(fail-open)".
            # It KEPT PASSING after the gate was closed, because the new refusal is 503 and 503 is
            # also != 401 -- a test passing for the wrong reason while asserting the opposite of the
            # behaviour it now covers. Asserting the exact status is what makes it mean something.
            check("unset token: work route is REFUSED 503, never served", r.status == 503)
        finally:
            await client.close()

        os.environ[bearer.TOKEN_ENV] = "test-token-value"
        client = await _client()
        try:
            r = await client.get("/health")
            check("armed: /health 200 without bearer", r.status == 200)
            r = await client.post("/finish", json={})
            check("armed: no bearer -> 401", r.status == 401)
            body = await r.json()
            check("armed: 401 body is unauthorized", body.get("error") == "unauthorized")
            r = await client.post("/finish", json={}, headers={"Authorization": "Bearer wrong"})
            check("armed: wrong bearer -> 401", r.status == 401)
            r = await client.post(
                "/finish", json={}, headers={"Authorization": "Bearer test-token-value"}
            )
            check("armed: good bearer is not 401", r.status != 401)
        finally:
            await client.close()
    finally:
        if prev_allow is None:
            os.environ.pop(bearer.ALLOW_UNAUTH_ENV, None)
        else:
            os.environ[bearer.ALLOW_UNAUTH_ENV] = prev_allow
        if prev is None:
            os.environ.pop(bearer.TOKEN_ENV, None)
        else:
            os.environ[bearer.TOKEN_ENV] = prev

    if check.failed:
        print(f"{check.failed} failed")
        sys.exit(1)
    print("bearer: all ok")


if __name__ == "__main__":
    asyncio.run(main())
