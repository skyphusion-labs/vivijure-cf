"""POST /async/join-films: its refusals and its job id. aiohttp, no ffmpeg, no network.

    python3 test_join_films.py

Exits non-zero on any failed assertion. Probes are stubbed here, so this proves the decisions and not the
join. Real ffmpeg, a real audio measurement and real HTTP are test_local_join_films.py.
"""
import asyncio
import os
import sys
import time

os.environ.setdefault("LOCAL_FINISH_TOKEN", "test-token")

from aiohttp.test_utils import TestClient, TestServer

import app

R2 = "https://acct.r2.cloudflarestorage.com/bucket"
HEADERS = {"Authorization": "Bearer test-token"}
failed = []


def check(name, ok, got=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name} {got}")
    if not ok:
        failed.append(name)


def body(n=2, sig="a"):
    return {
        "films": [{"url": f"{R2}/r{i}.mp4?X-Amz-Signature={sig}"} for i in range(n)],
        "outputUrl": f"{R2}/joined.mp4?X-Amz-Signature={sig}",
        "outputKey": "joined.mp4",
    }


def refused(name, b, status, text):
    try:
        app._parse_join_body(b)
    except app._JobError as e:
        check(name, e.status == status and text in e.message, e.message)
        return
    check(name, False, "accepted")


def part(size=100, duration=10.0, **over):
    video = {"codec_name": "h264", "profile": "High", "width": 1920, "height": 1080, "pix_fmt": "yuv420p",
             "r_frame_rate": "24/1", "time_base": "1/12288"}
    audio = {"sample_rate": "48000", "channels": 2}
    has_audio = over.pop("audio", True)
    for k, v in over.items():
        (audio if k in audio else video)[k] = v
    return {"duration": duration, "size": size, "video": video, "audio": audio if has_audio else None}


def parts_refused(name, parts, status, text):
    try:
        app._check_join_parts(parts)
    except app._JobError as e:
        check(name, e.status == status and text in e.message, e.message)
        return
    check(name, False, "accepted")


async def routes():
    runs = []
    release = asyncio.Event()

    async def held_work(b):
        runs.append(b)
        await release.wait()
        return {"ok": True}

    real_work = app.ASYNC_WORKS["join-films"]
    app.ASYNC_WORKS["join-films"] = held_work
    client = TestClient(TestServer(app.app))
    await client.start_server()
    try:
        r = await client.post("/async/join-films", json=body())
        check("no bearer is refused", r.status == 401, r.status)
        check("no bearer starts nothing", runs == [])

        r = await client.post("/async/join-films", json={"films": []}, headers=HEADERS)
        check("a bad body is refused at submit", r.status == 400, r.status)
        check("a bad body starts nothing", app.JOBS == {})

        r = await client.post("/async/join-films", json=body(sig="a"), headers=HEADERS)
        first = await r.json()
        check("submit is 202 pending", r.status == 202 and first["status"] == "pending", first)
        await asyncio.sleep(0)
        r = await client.post("/async/join-films", json=body(sig="b"), headers=HEADERS)
        second = await r.json()
        check("a re-submit with new signatures finds the same job", second["jobId"] == first["jobId"], second)
        await asyncio.sleep(0)
        check("a re-submit while running starts no second join", len(runs) == 1, len(runs))

        release.set()
        for _ in range(100):
            if app.JOBS[first["jobId"]]["status"] != "pending":
                break
            await asyncio.sleep(0.01)
        r = await client.post("/async/join-films", json=body(sig="c"), headers=HEADERS)
        third = await r.json()
        await asyncio.sleep(0)
        check("a re-submit after completion reports completion", third["status"] == "completed", third)
        check("a re-submit after completion runs nothing", len(runs) == 1, len(runs))

        app.JOBS[first["jobId"]] = {"status": "failed", "error": "x", "at": time.monotonic()}
        r = await client.post("/async/join-films", json=body(sig="d"), headers=HEADERS)
        fourth = await r.json()
        await asyncio.sleep(0)
        check("a failed join runs again", fourth["status"] == "pending" and len(runs) == 2, (fourth, len(runs)))

        app.JOBS.clear()
        r = await client.get(f"/async/status/{first['jobId']}", headers=HEADERS)
        check("a restart reads as not_found", r.status == 404, r.status)
        r = await client.post("/async/join-films", json=body(sig="e"), headers=HEADERS)
        fifth = await r.json()
        await asyncio.sleep(0)
        check("a re-submit after a restart runs under the same id",
              fifth["jobId"] == first["jobId"] and len(runs) == 3, (fifth, len(runs)))

        app.ASYNC_WORKS["finish"] = held_work
        r1 = await (await client.post("/async/finish", json={}, headers=HEADERS)).json()
        r2 = await (await client.post("/async/finish", json={}, headers=HEADERS)).json()
        check("every other route still mints its own id", r1["jobId"] != r2["jobId"])
    finally:
        await client.close()
        app.ASYNC_WORKS["join-films"] = real_work


def put_cap():
    import tempfile
    real = app.MAX_FILM_BYTES
    with tempfile.NamedTemporaryFile() as f:
        f.write(b"x" * 11)
        f.flush()
        try:
            app.MAX_FILM_BYTES = 10
            try:
                asyncio.run(app._put_file(None, "https://never/x", f.name))
                check("an output over one upload is refused before the PUT", False, "no refusal")
            except app._JobError as e:
                check("an output over one upload is refused before the PUT", e.status == 413, e.message)
        finally:
            app.MAX_FILM_BYTES = real


def probe_errors():
    real = app._run
    signed = "https://acct.r2.cloudflarestorage.com/b/r.mp4?X-Amz-Signature=SECRETSIG"

    def fail(cmd, **k):
        raise app.subprocess.CalledProcessError(1, cmd, stderr=signed)
    try:
        app._run = fail
        try:
            app._probe_join_part(signed)
            check("a failed probe is refused", False)
        except app._JobError as e:
            check("a failed probe is a 502 with no signed URL", e.status == 502 and "SECRETSIG" not in e.message, e.message)
    finally:
        app._run = real


def work_result():
    """_join_films_work with ffmpeg stubbed: the offsets, the failure mapping, and no upload on a failure."""
    real = (app._probe_join_part, app._concat_hard_urls, app._probe_duration, app._stream_seconds, app._put_file)
    puts = []

    async def put(_s, _u, _p):
        puts.append(1)
        return 7
    try:
        app._probe_join_part = lambda u: part(duration=2.5 if "r0" in u else 4.0)
        app._concat_hard_urls = lambda *a, **k: None
        app._stream_seconds = lambda p, sel: 6.5
        app._put_file = put
        app._probe_duration = lambda p: 6.5
        out = asyncio.run(app._join_films_work(body(2)))
        check("offsets add up the films before each", out["filmOffsetsSeconds"] == [0.0, 2.5], out["filmOffsetsSeconds"])
        check("film lengths are reported", out["filmSeconds"] == [2.5, 4.0], out["filmSeconds"])
        check("the result uploads once", len(puts) == 1 and out["bytes"] == 7)
        app._probe_duration = lambda p: 4.0
        try:
            asyncio.run(app._join_films_work(body(2)))
            check("a short join is refused", False)
        except app._JobError as e:
            check("a short join is a 500 with no upload", e.status == 500 and "dropped" in e.message and len(puts) == 1, e.message)
    finally:
        app._probe_join_part, app._concat_hard_urls, app._probe_duration, app._stream_seconds, app._put_file = real


def main():
    check("the cap is the documented limit of one R2 PUT", app.MAX_FILM_BYTES == 5 * 1024**3 - 5 * 1024**2)
    check("join-films is an async route", "join-films" in app.ASYNC_WORKS)

    urls, out = app._parse_join_body(body(3))
    check("a good body parses in order", len(urls) == 3 and "r0" in urls[0] and "r2" in urls[2] and "joined" in out)
    refused("no films", {"outputUrl": f"{R2}/o"}, 400, "films must be")
    refused("empty films", {"films": [], "outputUrl": f"{R2}/o"}, 400, "films must be")
    refused("a body that is not an object", [], 400, "must be an object")
    refused("too many films", body(app.MAX_JOIN_FILMS + 1), 400, "too many")
    refused("a film with no url", {"films": [{}], "outputUrl": f"{R2}/o"}, 400, "films[0].url missing")
    refused("a film off the allowlist", {"films": [{"url": "https://evil.example/x"}], "outputUrl": f"{R2}/o"},
            400, "films[0].url blocked")
    refused("http is blocked", {"films": [{"url": "http://acct.r2.cloudflarestorage.com/x"}], "outputUrl": f"{R2}/o"},
            400, "blocked")
    refused("no output", {"films": [{"url": f"{R2}/x"}]}, 400, "outputUrl required")
    refused("an output off the allowlist", {"films": [{"url": f"{R2}/x"}], "outputUrl": "https://evil.example/o"},
            400, "outputUrl blocked")
    for bad in ("'", "\n", "\r", "\\"):
        refused(f"a url carrying {bad!r} cannot reach the concat list",
                {"films": [{"url": f"{R2}/x{bad}y"}], "outputUrl": f"{R2}/o"}, 400, "concat list")

    check("the id ignores signatures", app._join_job_id(body(sig="a")) == app._join_job_id(body(sig="b")))
    swapped = body()
    swapped["films"].reverse()
    check("the id depends on order", app._join_job_id(body()) != app._join_job_id(swapped))
    other = body()
    other["outputUrl"] = f"{R2}/other.mp4"
    check("the id depends on the output", app._join_job_id(body()) != app._join_job_id(other))
    check("the id depends on the parts", app._join_job_id(body(2)) != app._join_job_id(body(3)))
    check("the id has no dot, which the studio door uses as its separator", "." not in app._join_job_id(body()))

    app._check_join_parts([part(), part()])
    print("ok   matching parts pass")
    parts_refused("a different frame", [part(), part(width=1280)], 422, "films[1] differs from films[0] in video: width")
    parts_refused("a different rate", [part(), part(r_frame_rate="48/1")], 422, "r_frame_rate")
    parts_refused("a different time base", [part(), part(time_base="1/24000")], 422, "time_base")
    parts_refused("a different codec", [part(), part(codec_name="hevc")], 422, "codec_name")
    parts_refused("a different pixel format", [part(), part(pix_fmt="yuv444p")], 422, "pix_fmt")
    parts_refused("a different sample rate", [part(), part(sample_rate="44100")], 422, "in audio: sample_rate")
    parts_refused("a different channel count", [part(), part(channels=1)], 422, "channels")
    parts_refused("one film with no audio", [part(), part(audio=False)], 422, "no audio track")
    app._check_join_parts([part(audio=False), part(audio=False)])
    print("ok   parts that are all silent pass")
    half = app.MAX_FILM_BYTES // 2
    app._check_join_parts([part(size=half), part(size=half)])
    print("ok   a join at the upload limit passes")
    parts_refused("a join over one upload", [part(size=half + 1), part(size=half + 1)], 413, "limit of one upload")

    put_cap()
    probe_errors()
    work_result()
    asyncio.run(routes())
    print(f"failed={len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
