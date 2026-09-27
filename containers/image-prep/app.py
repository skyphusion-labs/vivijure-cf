"""Image-prep container: rembg background removal over HTTP.

The Worker presigns an R2 GET (source portrait) and PUT (cleaned PNG) and POSTs
both to /portrait/prep; we fetch the source, strip the background with rembg
(u2net), optionally composite onto black, and PUT the result. Image bytes never
touch the Worker. CPU-only onnxruntime; no R2 binding (presign keeps creds on
the Worker). See docs/image-prep-container.md.
"""
import asyncio
import logging
import os
import threading
import time
from io import BytesIO

from aiohttp import ClientSession, ClientTimeout, web
from PIL import Image

from bearer import bearer_middleware, require_bearer_config
from url_guard import guarded_get, guarded_put, validate_fetch_url

# rembg is intentionally NOT imported at module load. `import rembg` pulls in
# pymatting, which JIT-compiles numba kernels on import (~46s on a cold cache,
# ~1.5s on the baked cache). Doing that before web.run_app binds :8000 trips the
# container runtime's port-ready check ("not listening on :8000").
#
# We do NOT warm at startup either: a background warm thread, on the small-core
# CF Container instance, contends for the GIL and DELAYS the bind across several
# port-ready polls until the cold-cache compile finishes (the cache is compiled
# for the build host's CPU, so it can miss on CF). The sibling audio container
# has no startup warm and cold-starts fine, so we match it: bind first, import
# rembg lazily on the first /portrait/prep. /health never touches rembg.

PORT = int(os.environ.get("PORT", "8000"))
DOWNLOAD_TIMEOUT_S = 30
UPLOAD_TIMEOUT_S = 30
MAX_INPUT_BYTES = 32 * 1024 * 1024  # 32 MB upper bound on a portrait

# cf#869: MAX_INPUT_BYTES bounds COMPRESSED bytes. The decoded bitmap is a function of PIXEL
# DIMENSIONS, and nothing bounded those, so a small, highly compressible image (a flat colour field,
# or a deliberately crafted one) passed the 32 MB gate and decoded to an allocation orders of
# magnitude larger. The gate measured the wrong quantity, confidently.
#
# WHERE THE COST IS PAID, which decides where the check goes: `rembg.remove()` decodes the input
# ITSELF, before any Pillow call in this module. A guard in front of `Image.open` would sit behind
# the allocation it is meant to prevent. This one runs before rembg.
#
# WHERE THE NUMBER COMES FROM, rather than a round figure: the subject is a single cast reference
# portrait. 4096x4096 comfortably covers a modern phone photo (4032x3024 is 12.2 MP) and decodes to
# about 64 MiB as RGBA, which is the real bound this buys. Anything larger is not a portrait.
# Env-tunable like the other container constants, so a deployment can lower it without a rebuild.
MAX_INPUT_PIXELS = int(os.environ.get("MAX_INPUT_PIXELS", str(4096 * 4096)))

# Defense in depth, and deliberately NOT the only line of defense. Pillow WARNS above this value and
# only raises DecompressionBombError above 2x it, so on its own it would let an image through at up
# to twice our ceiling. The explicit check in _guard_decode_size is what actually refuses; this
# stops a decode we did not route through that check from going unbounded.
Image.MAX_IMAGE_PIXELS = MAX_INPUT_PIXELS


class DecodeTooLarge(Exception):
    """The image is small compressed and large decoded. Carries the dimensions so the refusal can
    name them: an operator has to be able to tell "your image is too large to decode" from "the
    container fell over", and a bare 413 or an OOM renders those as one state."""

    def __init__(self, width: int, height: int, ceiling: int) -> None:
        super().__init__(
            f"image decodes to {width}x{height} = {width * height} pixels, above the "
            f"{ceiling}-pixel MAX_INPUT_PIXELS ceiling; "
            f"compressed size is not a bound on decoded size"
        )
        self.width, self.height, self.ceiling = width, height, ceiling


def _guard_decode_size(data: bytes) -> "tuple[int, int]":
    """Read the header ONLY and refuse an image whose decoded size we will not pay for.

    `Image.open` is lazy: it parses the header and exposes `.size` without decoding pixels, so this
    costs nothing and runs before rembg touches the bytes.

    An image Pillow cannot identify is REFUSED rather than passed through. rembg decodes through
    Pillow too, so anything unreadable here fails there anyway -- but it would fail AFTER the
    allocation, which is the thing being prevented. Refusing early turns a 500 into an honest 400.
    """
    # Pillow's OWN bomb check is suspended for the header read, and that is deliberate rather than
    # a weakening. It raises DecompressionBombError at 2x MAX_IMAGE_PIXELS, which would pre-empt the
    # check below and surface a large image as "could not identify image" -- refused, but with the
    # wrong reason, which is the same two-states-as-one defect this guard exists to close. Reading a
    # header allocates nothing, so there is no bomb to defend against at this point; the limit is
    # restored immediately and still covers every decode that does not come through here.
    previous_limit = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = None
    try:
        with Image.open(BytesIO(data)) as probe:
            width, height = probe.size
    except Exception as e:  # noqa: BLE001 - any header failure means we cannot bound the decode
        raise ValueError(f"could not identify image: {e}") from e
    finally:
        Image.MAX_IMAGE_PIXELS = previous_limit
    if width * height > MAX_INPUT_PIXELS:
        raise DecodeTooLarge(width, height, MAX_INPUT_PIXELS)
    return width, height

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("image-prep")


def _elapsed_ms(t0: float) -> int:
    """Wall-clock ms since t0 (cf#268 capacity telemetry). Integer, never negative."""
    return max(0, int(round((time.monotonic() - t0) * 1000)))


# Lazily-created ORT session, guarded so the background warm task and a
# concurrent first request don't both build it.
_SESSION = None
_SESSION_LOCK = threading.Lock()


def _get_session():
    global _SESSION
    if _SESSION is None:
        with _SESSION_LOCK:
            if _SESSION is None:
                from rembg import new_session  # deferred; see module note

                log.info("loading rembg u2net session...")
                _SESSION = new_session("u2net")
                log.info("rembg u2net session ready")
    return _SESSION


async def health(_req):
    return web.json_response({"ok": True})


async def prep(req):
    t0 = time.monotonic()
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)

    input_url = body.get("inputUrl")
    output_url = body.get("outputUrl")
    output_key = body.get("outputKey", "")
    background = body.get("background", "alpha")
    if not input_url or not output_url or background not in ("alpha", "black"):
        return web.json_response({"ok": False, "error": "bad input"}, status=400)

    # Fetch the source portrait.
    try:
        async with ClientSession(timeout=ClientTimeout(total=DOWNLOAD_TIMEOUT_S)) as s:
            async with guarded_get(s, input_url) as r:  # codeql[py/full-ssrf]
                if r.status != 200:
                    return web.json_response({"ok": False, "error": f"input fetch {r.status}"}, status=502)
                data = b""
                async for chunk in r.content.iter_chunked(64 * 1024):
                    data += chunk
                    if len(data) > MAX_INPUT_BYTES:
                        return web.json_response({"ok": False, "error": "input too large"}, status=413)
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

    # cf#869: bound the DECODE before rembg touches the bytes. MAX_INPUT_BYTES above bounded the
    # compressed size only, and the two are not related by any ratio an attacker cannot choose.
    try:
        await asyncio.get_running_loop().run_in_executor(None, _guard_decode_size, data)
    except DecodeTooLarge as e:
        # 413 like the byte cap, but naming the DECODED dimensions, so the two refusals are
        # distinguishable without reading container logs.
        return web.json_response(
            {"ok": False, "error": str(e), "width": e.width, "height": e.height,
             "maxPixels": e.ceiling},
            status=413,
        )
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

    try:
        loop = asyncio.get_running_loop()
        out_bytes, w, h = await loop.run_in_executor(None, _process, data, background)
    except Exception as e:  # noqa: BLE001 - surface processing failure as 500
        log.exception("rembg failed")
        return web.json_response({"ok": False, "error": str(e)}, status=500)

    # PUT the cleaned PNG to the presigned output URL.
    try:
        async with ClientSession(timeout=ClientTimeout(total=UPLOAD_TIMEOUT_S)) as s:
            async with guarded_put(s, output_url, data=out_bytes, headers={"content-type": "image/png"}) as r:  # codeql[py/full-ssrf]
                if r.status not in (200, 201, 204):
                    return web.json_response({"ok": False, "error": f"output put {r.status}"}, status=502)
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

    return web.json_response({
        "ok": True,
        "key": output_key,
        "bytes": len(out_bytes),
        "width": w,
        "height": h,
        "background": background,
        "elapsedMs": _elapsed_ms(t0),  # cf#268 capacity telemetry
    })


def _process(data, background):
    from rembg import remove  # deferred; see module note

    cleaned = remove(data, session=_get_session())  # bytes in, PNG RGBA bytes out
    img = Image.open(BytesIO(cleaned)).convert("RGBA")
    if background == "black":
        bg = Image.new("RGB", img.size, "black")
        bg.paste(img, mask=img.split()[3])
        img = bg
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), img.size[0], img.size[1]


# cf#893: image-prep and audio-master had NO bearer gate at all, only url_guard. Three
# vendored copies of bearer.py drifted and nobody was counting the containers that lacked one.
# tests/container-bearer-gate.test.py now derives the list from app.py rather than carrying it,
# so the next container inherits this requirement instead of having to remember it.
app = web.Application(middlewares=[bearer_middleware])
app.router.add_get("/health", health)
app.router.add_post("/portrait/prep", prep)

if __name__ == "__main__":
    # cf#893: refuse to START without auth configured. At the real entry point rather than at module
    # scope, and the difference is deliberate: `python app.py` is what the Dockerfile CMD runs, so
    # this is the door opening, while an IMPORT is a test reading the module. Eleven container tests
    # import app; gating import would have broken all of them for no security gain, because
    # bearer_middleware independently answers 503 on every media route when no token is set.
    # Two layers, each meaningful: this one refuses to bind, that one refuses to serve.
    require_bearer_config()
    log.info("image-prep listening on 0.0.0.0:%d", PORT)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None)
