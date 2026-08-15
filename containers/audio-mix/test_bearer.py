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
    try:
        os.environ.pop(bearer.TOKEN_ENV, None)
        client = await _client()
        try:
            r = await client.get("/health")
            check("unset token: /health 200", r.status == 200)
            r = await client.post("/mix", json={})
            check("unset token: work route still reachable (fail-open)", r.status != 401)
        finally:
            await client.close()

        os.environ[bearer.TOKEN_ENV] = "test-token-value"
        client = await _client()
        try:
            r = await client.get("/health")
            check("armed: /health 200 without bearer", r.status == 200)
            r = await client.post("/mix", json={})
            check("armed: no bearer -> 401", r.status == 401)
            body = await r.json()
            check("armed: 401 body is unauthorized", body.get("error") == "unauthorized")
            r = await client.post("/mix", json={}, headers={"Authorization": "Bearer wrong"})
            check("armed: wrong bearer -> 401", r.status == 401)
            r = await client.post(
                "/mix", json={}, headers={"Authorization": "Bearer test-token-value"}
            )
            check("armed: good bearer is not 401", r.status != 401)
        finally:
            await client.close()
    finally:
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
