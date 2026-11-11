"""vivijure-cf#1338: assembly holds a clip's last frame to its planned length, and never cuts its audio.

    python3 test_hold.py

No ffmpeg, no network: the probes and `_run` are replaced, so this proves the decision and the ffmpeg
arguments each clip is GIVEN. That those arguments produce a held frame and an uncut audio track is
test_local_hold.py, which needs a real ffmpeg and measures the output.
"""
import asyncio
import os
import sys

os.environ.setdefault("LOCAL_FINISH_TOKEN", "test-token")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app

failed = []


def check(name, ok, got=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name} {got}")
    if not ok:
        failed.append(name)


def capture_normalize(**k):
    seen = []
    real = app._run
    app._run = lambda cmd, timeout=None: seen.append(list(cmd))
    try:
        app._normalize("in.mp4", "out.mp4", width=320, height=180, fps=25, crf=23, preset="veryfast", **k)
    finally:
        app._run = real
    return seen[0]


def arg(cmd, flag):
    return cmd[cmd.index(flag) + 1] if flag in cmd else None


def tpad_stop_duration(vf):
    """The stop_duration of a tpad clone in a -vf chain, or None. stop_duration is how much the clone may add,
    so a hold to N seconds needs it to be at least N; a 0 adds nothing and the clip stays short."""
    import re
    m = re.search(r"tpad=stop_mode=clone:stop_duration=([0-9.]+)", vf or "")
    return float(m.group(1)) if m else None


def main():
    # ---- the decision, pure.
    H = app._hold_extension
    check("a held clip runs to its planned seconds", H(0.36, 0.43, 2.0, True) == 2.0, H(0.36, 0.43, 2.0, True))
    check("a talking clip's video runs as long as its own audio (the 70 ms)", H(0.36, 0.429, None, True) == 0.429)
    check("a silent film ignores the audio length", H(0.36, 0.429, None, False) is None)
    check("a silent film is still held", H(0.36, None, 2.0, False) == 2.0)
    check("a clip already long enough is left alone", H(2.5, 2.4, 2.0, True) is None)
    check("an unreadable video length is left alone", H(None, 0.43, 2.0, True) is None)
    check("a gap under a millisecond is not a gap", H(2.0, 2.0004, None, True) is None)

    # ---- the request fields.
    P = app._parse_seconds
    check("holdToSeconds is read", P({"url": "u", "holdToSeconds": 2}, "holdToSeconds") == 2.0)
    check("a missing, zero, negative or bad hold is None",
          [P({}, "holdToSeconds"), P({"holdToSeconds": 0}, "holdToSeconds"), P({"holdToSeconds": -1}, "holdToSeconds"),
           P({"holdToSeconds": "x"}, "holdToSeconds")] == [None, None, None, None])

    # ---- the plan, with the probes replaced: the tail-trim of a join is taken from the HELD length.
    real_stream, real_dur = app._probe_stream_duration, app._probe_duration
    app._probe_stream_duration = lambda p, s: 0.36 if s == "v:0" else 0.43
    app._probe_duration = lambda p: 0.43
    try:
        cap, ext = app._clip_plan("c.mp4", None, 2.0, 0.04, True)
        check("held clip: extend to 2.0, then the join trims one frame off the HELD length",
              ext == 2.0 and abs(cap - 1.96) < 1e-9, (cap, ext))
        cap, ext = app._clip_plan("c.mp4", None, None, 0.0, True)
        check("talking clip, last in the film: extend to its audio, no cap from a trim", ext == 0.43 and cap is None, (cap, ext))
        cap, ext = app._clip_plan("c.mp4", None, None, 0.04, False)
        check("silent, no hold: nothing extended, the old trim from the clip's length", ext is None and abs(cap - 0.39) < 1e-9, (cap, ext))
        cap, ext = app._clip_plan("c.mp4", 1.0, 2.0, 0.0, True)
        check("an explicit targetSeconds still caps the clip", ext == 2.0 and cap == 1.0, (cap, ext))
    finally:
        app._probe_stream_duration, app._probe_duration = real_stream, real_dur

    # ---- the ffmpeg arguments.
    real_audio = app._probe_audio
    app._probe_audio = lambda p: (True, 44100, "stereo")
    try:
        cmd = capture_normalize(cap=None, ensure_audio=True, extend_to=2.0)
        vf = arg(cmd, "-vf") or ""
        check("the video holds its last frame (tpad clone)", "tpad=stop_mode=clone" in vf, vf)
        sd = tpad_stop_duration(vf)
        check("the clone may add at least the whole hold (stop_duration >= 2.0)", sd is not None and sd >= 2.0, sd)
        check("the audio is padded to the same length, never cut", arg(cmd, "-af") == "apad=whole_dur=2.000", arg(cmd, "-af"))
        check("the clip is bounded at the held length", arg(cmd, "-t") == "2.000", arg(cmd, "-t"))
        cmd = capture_normalize(cap=1.96, ensure_audio=True, extend_to=2.0)
        check("a join trim still applies to a held clip", arg(cmd, "-t") == "1.960", arg(cmd, "-t"))
        cmd = capture_normalize(cap=None, ensure_audio=True)
        check("no hold: no tpad and no apad, as before", "tpad" not in (arg(cmd, "-vf") or "") and "-af" not in cmd, cmd)
        cmd = capture_normalize(cap=None, extend_to=2.0)
        check("a silent film is held with its audio dropped", "tpad=stop_mode=clone" in (arg(cmd, "-vf") or "") and "-an" in cmd and "-af" not in cmd, cmd)
        check("a silent film's clone may add the whole hold too", (tpad_stop_duration(arg(cmd, "-vf")) or 0) >= 2.0, arg(cmd, "-vf"))
    finally:
        app._probe_audio = real_audio

    # ---- the CALL SITES: /finish hands each clip's holdToSeconds to the assemble, on both paths. Only the
    # download and the first encoding step are replaced; the request parsing runs for real.
    R2 = "https://acct.r2.cloudflarestorage.com"
    body = {"clips": [{"url": R2 + "/a.mp4", "holdToSeconds": 2}, {"url": R2 + "/b.mp4"}],
            "outputUrl": R2 + "/film.mp4", "outputKey": "film.mp4", "keepClipAudio": True}

    class Stop(Exception):
        pass

    async def fake_download(session, url, path, cap):
        with open(path, "wb") as f:
            f.write(b"x")
        return True, ""

    seen = {}

    def fake_assemble(work, srcs, *a, **k):
        seen["srcs"] = [tuple(x[1:]) for x in srcs]
        raise Stop()

    def fake_batch(batch_dir, batch, *a, **k):
        seen.setdefault("batch", []).extend(tuple(x[1:]) for x in batch)
        raise Stop()

    reals = (app._download, app._assemble, app._normalize_batch)
    app._download, app._assemble, app._normalize_batch = fake_download, fake_assemble, fake_batch
    try:
        for b, label in ((body, "single-pass"),
                         ({**body, "partialUrls": [{"put": R2 + "/p0.put", "get": R2 + "/p0.get"}]}, "chunked")):
            try:
                asyncio.run(app._finish_work(dict(b)))
            except Exception:
                pass
        check("single-pass: the held clip reaches _assemble with 2.0, the other with none",
              seen.get("srcs") == [(None, 2.0), (None, None)], seen.get("srcs"))
        check("chunked: the held clip reaches its batch with 2.0, the other with none",
              seen.get("batch") == [(None, 0, 2.0), (None, 1, None)], seen.get("batch"))
    finally:
        app._download, app._assemble, app._normalize_batch = reals

    print("all passed" if not failed else f"{len(failed)} failed: {failed}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
