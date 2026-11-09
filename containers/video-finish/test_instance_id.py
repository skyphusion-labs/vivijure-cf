"""cf#784: every async body says which process answered, so a job lost to a restart can be told
apart from one that never existed. Stubbed work, no ffmpeg, no network. Requires aiohttp.

Run:  python3 test_instance_id.py
Exits non-zero on any failed assertion.
"""
import asyncio
import sys

from aiohttp.test_utils import TestClient, TestServer

import app


def check(name, cond):
    if cond:
        print(f"  ok  {name}")
    else:
        print(f"FAIL  {name}")
        check.failed += 1
check.failed = 0


async def main():
    gate = asyncio.Event()

    async def held_work(body):
        # Stays pending until released, so the "restart" lands while the job is running.
        await gate.wait()
        return {"ok": True}

    app.ASYNC_WORKS = {"finish": held_work}
    check("CONTROL: the instance id is a non-empty string", isinstance(app.INSTANCE_ID, str) and len(app.INSTANCE_ID) >= 16)
    first = app.INSTANCE_ID

    client = TestClient(TestServer(app.app))
    await client.start_server()
    try:
        r = await client.post("/async/finish", json={})
        sub = await r.json()
        check("submit 202", r.status == 202)
        check("submit names the instance that accepted it", sub.get("instance") == first)

        r = await client.get(f"/async/status/{sub['jobId']}")
        st = await r.json()
        check("pending status names the same instance", st.get("status") == "pending" and st.get("instance") == first)

        # A job this process never had: not_found, from the SAME instance. "Never existed."
        r = await client.get("/async/status/never-submitted-784")
        nf = await r.json()
        check("unknown job: 404 not_found", r.status == 404 and nf.get("status") == "not_found")
        check("unknown job: answered by the same instance", nf.get("instance") == first)

        # A restart: a new process has a new id and an empty registry. Simulated in place, because the
        # registry and the id are the only process state this concerns.
        app.JOBS.clear()
        app.INSTANCE_ID = "restarted-" + first
        r = await client.get(f"/async/status/{sub['jobId']}")
        lost = await r.json()
        check("lost job: 404 not_found", r.status == 404 and lost.get("status") == "not_found")
        check("lost job: answered by a DIFFERENT instance than accepted it", lost.get("instance") not in (None, sub.get("instance")))
    finally:
        gate.set()
        await client.close()

    if check.failed:
        print(f"\n{check.failed} instance-id check(s) FAILED")
        sys.exit(1)
    print("\nall instance-id checks passed")


asyncio.run(main())
