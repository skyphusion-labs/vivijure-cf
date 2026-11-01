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


HARD_TITLES = [
    "Two O'Clock", "Reel: one", "a\\b", "100% done", "It's 2:00 o'clock", "a, b; [c] = d",
    "'quoted' \"double\"", "%{pts}", "back\\'slash:mix", "trail\\", "x=1:y=2", "Mara's \\: [cut], 50%; don't",
]


def escape_matches_textfile(out_dir):
    """vivijure-cf#1218: the same text drawn through _escape_drawtext and through textfile= has the same pixels."""
    font = f"fontfile='{FONT}'" if FONT else "font='DejaVu Sans'"
    bad = []
    for i, title in enumerate(HARD_TITLES):
        source = os.path.join(out_dir, f"title_{i}.txt")
        with open(source, "w", encoding="utf-8") as f:
            f.write(title)
        frames = []
        for name, arg in (("a", f"textfile={source}"), ("b", f"text={app._escape_drawtext(title)}")):
            out = os.path.join(out_dir, f"title_{i}_{name}.png")
            vf = f"drawtext={font}:fontcolor=white:fontsize=40:x=20:y=20:expansion=none:{arg}"
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=black:s=1400x120:d=0.1",
                 "-frames:v", "1", "-vf", vf, out],
                check=True,
            )
            frames.append(Image.open(out).convert("RGB").tobytes())
        if frames[0] != frames[1]:
            bad.append(title)
    print(f"escape against textfile: {len(HARD_TITLES)} titles, bad={bad}")
    return bad


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
    if escape_matches_textfile(out_dir):
        return 1
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
