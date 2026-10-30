"""Real-render proof for cf#1111: draw the real filters with real ffmpeg and measure the ink.

Needs ffmpeg with drawtext and libass, plus Pillow. Not run in container-tests, for the runner reason
ci.yml gives for test_local.py. Set FRAME_TEXT_FONT to DejaVuSans.ttf when ffmpeg has no fontconfig.

    python3 test_local_frame_text.py [out_dir]

Exits non-zero on any failed assertion. Prints the measured boxes, and leaves PNGs in out_dir.
"""
import os
import subprocess
import sys
import tempfile

from PIL import Image

import app

TITLE = "Smoke 1.41.0 vertical"
LONG = "The Very Long Name Of A Film That Somebody Really Did Type Into The Box"
DIALOGUE = "I never told anyone this. The night we met, I almost didn't come."
FONT = os.environ.get("FRAME_TEXT_FONT")


def render(vf, width, height, out):
    if FONT:
        vf = vf.replace("font='DejaVu Sans'", f"fontfile='{FONT}'")
        if "subtitles=" in vf:
            vf = vf.replace(":force_style=", f":fontsdir='{os.path.dirname(FONT)}':force_style=")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r=24:d=1",
         "-vf", vf, "-frames:v", "1", "-update", "1", out],
        check=True, capture_output=True, text=True,
    )
    img = Image.open(out).convert("L").point(lambda v: 255 if v > 64 else 0)
    return img.getbbox()


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="frametext-")
    failures = []

    def check(name, ok, got):
        print(f"{'ok  ' if ok else 'FAIL'} {name} {got}")
        if not ok:
            failures.append(name)

    srt = os.path.join(out_dir, "s.srt")
    with open(srt, "w", encoding="utf-8") as f:
        f.write(f"1\n00:00:00,000 --> 00:00:05,000\n{DIALOGUE}\n")
    style = {"font": "DejaVu Sans", "fontSize": 28, "color": "white"}

    for w, h in [(720, 1280), (1080, 1920), (1920, 1080), (1344, 768)]:
        tag = f"{w}x{h}"
        for name, text in (("title", TITLE), ("long", LONG)):
            box = render(app._title_card_filter(text, width=w, height=h), w, h, f"{out_dir}/{name}-{tag}.png")
            check(f"{name} stays on the card at {tag}", box is not None and box[0] > 0 and box[2] < w, box)
        box = render(app._subtitle_filter(srt, style, w, h), w, h, f"{out_dir}/caption-{tag}.png")
        share = (box[3] - box[1]) / h if box else 1
        check(f"caption stays on the frame at {tag}", box is not None and box[0] >= 0 and box[2] <= w, box)
        check(f"caption takes at most a quarter of {tag}", share <= 0.25, round(share, 3))

    print(f"pngs in {out_dir}; failed={len(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
