"""cf#869: the decode bound. Pillow + stdlib, no network, no Docker, no rembg.

MAX_INPUT_BYTES gates COMPRESSED bytes. The decoded bitmap is a function of PIXEL DIMENSIONS, and
until cf#869 nothing bounded those: a small, highly compressible image passed the 32 MB gate and
decoded to an allocation orders of magnitude larger. The gate measured the wrong quantity.

This proves the new bound in BOTH directions, because a guard proven in one direction is half a
guard: a crafted bomb is REFUSED with a diagnostic naming the decoded dimensions, and a legitimate
cast portrait is still ADMITTED in the same module with the same ceiling in force.

The bomb is built by hand from a PNG header rather than by Pillow, deliberately. Asking Pillow to
create a 20000x20000 image would allocate 1.2 GB in the test -- the very thing being prevented --
and it is unnecessary: `Image.open` reads `.size` out of IHDR without decoding a pixel, which is
exactly the property the guard relies on and therefore exactly the property worth testing.

Run:  python3 test_decode_bound.py
Exits non-zero on any failed assertion.
"""
import struct
import sys
import zlib
from io import BytesIO

sys.path.insert(0, __file__.rsplit("/", 1)[0])

from app import MAX_INPUT_PIXELS, DecodeTooLarge, _guard_decode_size  # noqa: E402
from PIL import Image  # noqa: E402

failures = []


def check(label, cond):
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        failures.append(label)


def png_header_claiming(width, height):
    """A structurally valid PNG whose IHDR claims `width` x `height`, with a one-pixel IDAT.

    This IS the decompression-bomb shape: a few hundred bytes on the wire that any decoder will
    expand to width*height*channels in memory. Nothing here is malformed -- that is the point.
    """
    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit truecolour
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00"))
            + chunk(b"IEND", b""))


def real_portrait_png(width=64, height=64):
    """A genuine small image, encoded by Pillow. The positive control."""
    buf = BytesIO()
    Image.new("RGB", (width, height), (120, 90, 70)).save(buf, format="PNG")
    return buf.getvalue()


print("cf#869 decode bound")

# --- the attack, and the measurement that makes it an attack ------------------------------------
BOMB_W = BOMB_H = 20_000
bomb = png_header_claiming(BOMB_W, BOMB_H)
decoded_bytes = BOMB_W * BOMB_H * 4  # RGBA

print(f"\n  crafted bomb: {len(bomb)} compressed bytes -> {BOMB_W}x{BOMB_H} "
      f"= {decoded_bytes / 1024 / 1024:.0f} MiB decoded as RGBA")

# The premise of the whole issue: this sails through the byte gate.
check("the bomb is FAR under MAX_INPUT_BYTES, so the byte cap cannot see it",
      len(bomb) < 32 * 1024 * 1024)
check("...and its decoded size is orders of magnitude larger than its compressed size",
      decoded_bytes > len(bomb) * 1000)

# --- REFUSAL ------------------------------------------------------------------------------------
try:
    _guard_decode_size(bomb)
    check("the guard REFUSES the bomb", False)
except DecodeTooLarge as e:
    check("the guard REFUSES the bomb", True)
    # The diagnostic must name the DECODED dimensions. A bare 413 leaves an operator unable to tell
    # "your image is too large to decode" from "the container fell over", which is the same
    # two-states-as-one defect one layer up.
    check("the refusal names the decoded width", e.width == BOMB_W)
    check("the refusal names the decoded height", e.height == BOMB_H)
    check("the refusal names the ceiling it applied", e.ceiling == MAX_INPUT_PIXELS)
    check("the message names the pixel count, not just 'too large'",
          str(BOMB_W * BOMB_H) in str(e))
except Exception as e:  # noqa: BLE001
    check(f"the guard REFUSES the bomb (got {type(e).__name__}: {e})", False)

# --- POSITIVE CONTROL: the guard must still let real work through -------------------------------
portrait = real_portrait_png()
try:
    w, h = _guard_decode_size(portrait)
    check("POSITIVE CONTROL: a legitimate cast portrait is ADMITTED", (w, h) == (64, 64))
except Exception as e:  # noqa: BLE001
    check(f"POSITIVE CONTROL: a legitimate cast portrait is ADMITTED (got {e})", False)

# A portrait at the realistic top end of the range must also pass, or the ceiling is too tight to
# ship: 4032x3024 is an ordinary 12 MP phone photo.
try:
    _guard_decode_size(png_header_claiming(4032, 3024))
    check("POSITIVE CONTROL: a 12 MP phone photo (4032x3024) is still admitted", True)
except DecodeTooLarge:
    check("POSITIVE CONTROL: a 12 MP phone photo (4032x3024) is still admitted", False)

# --- THE BOUNDARY, both sides, so the ceiling is a real edge and not a direction -----------------
side = int(MAX_INPUT_PIXELS ** 0.5)
try:
    _guard_decode_size(png_header_claiming(side, side))
    check(f"exactly AT the ceiling ({side}x{side}) is admitted", True)
except DecodeTooLarge:
    check(f"exactly AT the ceiling ({side}x{side}) is admitted", False)

try:
    _guard_decode_size(png_header_claiming(side + 1, side))
    check("one pixel-column OVER the ceiling is refused", False)
except DecodeTooLarge:
    check("one pixel-column OVER the ceiling is refused", True)

# --- an unreadable image cannot be bounded, so it is refused rather than passed on ---------------
try:
    _guard_decode_size(b"this is not an image at all")
    check("an unidentifiable image is refused (we cannot bound what we cannot read)", False)
except ValueError:
    check("an unidentifiable image is refused (we cannot bound what we cannot read)", True)
except DecodeTooLarge:
    check("an unidentifiable image is refused as unreadable, not as oversized", False)

print()
if failures:
    print(f"FAILED: {len(failures)}")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("all checks passed")
