"""Bounded ffmpeg/ffprobe runner for the video-finish container (cf#571).

A hung child used to hold one default-executor thread forever: no timeout
meant no TimeoutExpired, no counter, and /health kept answering. This helper
is the only subprocess entry for production ffmpeg/ffprobe in this container.

Pattern: vivijure-blender `_run(..., timeout=)` plus vivijure-upscale's
process-group kill. Timeout has a default so existing `_run(cmd)` call sites
stay mechanical; probes pass the shorter FFPROBE_TIMEOUT.
"""
import os
import signal
import subprocess

FFMPEG_TIMEOUT = int(os.environ.get("FFMPEG_TIMEOUT", "1200") or "1200")
FFPROBE_TIMEOUT = int(os.environ.get("FFPROBE_TIMEOUT", "60") or "60")


class FfmpegTimeout(RuntimeError):
    """Hung ffmpeg/ffprobe was killed. Assemble has no passthrough;
    callers surface this as a named 500, never as empty success."""


def _kill_process_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except OSError:
            pass


def _run(cmd, timeout=None, text=False, check=True):
    """Run an ffmpeg/ffprobe child with a wall-clock bound.

    On expiry the whole process group is SIGKILL'd so grandchildren cannot
    outlive the worker thread. Raises FfmpegTimeout (named).
    """
    if timeout is None:
        timeout = FFMPEG_TIMEOUT
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        text=text,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_process_group(proc)
        try:
            stdout, stderr = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
        raise FfmpegTimeout(f"ffmpeg timeout after {int(timeout)}s") from None
    if check and proc.returncode:
        raise subprocess.CalledProcessError(proc.returncode, cmd, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
