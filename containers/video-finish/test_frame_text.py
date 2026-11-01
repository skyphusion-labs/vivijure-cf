"""The numbers for frame_text and the filters built from it (cf#1111). Stdlib only, no ffmpeg, so it
runs in container-tests. A real render is test_local_frame_text.py.

    python3 test_frame_text.py

Exits non-zero on any failed assertion.
"""
import sys

import frame_text as ft

# The filters as they were before cf#1111, written out. Landscape must keep producing these bytes.
OLD_TITLE = ("drawtext=font='DejaVu Sans':text=My Film:expansion=none:fontsize=80:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2")
OLD_TITLE_SUB = (
    "drawtext=font='DejaVu Sans':text=My Film:expansion=none:fontsize=80:fontcolor=white:x=(w-text_w)/2:y=(h/2-text_h-16)"
    ",drawtext=font='DejaVu Sans':text=A Sub:expansion=none:fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h/2+16)"
)
OLD_CREDITS = (
    "drawtext=font='DejaVu Sans':text=One:expansion=none:fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-(t/8.000)*(h+136)+0)"
    ",drawtext=font='DejaVu Sans':text=Two:expansion=none:fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-(t/8.000)*(h+136)+68)"
)
OLD_CAPTION_STYLE = (
    "FontName=DejaVu Sans,FontSize=28,PrimaryColour=&H00FFFFFF,Alignment=2,MarginV=36,"
    "BorderStyle=1,Outline=2,Shadow=0"
)
LANDSCAPE = [(1920, 1080), (1344, 768), (1280, 720), (3840, 2160), (1024, 1024)]
VERTICAL = [(720, 1280), (1080, 1920), (768, 1344), (1080, 1350)]
SMOKE_TITLE = "Smoke 1.41.0 vertical"


def main():
    failures = []
    checks = 0

    def check(name, ok, got=""):
        nonlocal checks
        checks += 1
        print(f"{'ok  ' if ok else 'FAIL'} {name} {got}")
        if not ok:
            failures.append(name)

    for w, h in LANDSCAPE:
        check(f"card scale 1 at {w}x{h}", ft.card_scale(w, h) == 1.0)
        check(f"caption scale 1 at {w}x{h}", ft.caption_scale(w, h) == 1.0)
    check("a bad frame scales by 1", ft.card_scale(0, 0) == 1.0 and ft.caption_scale(-1, 5) == 1.0)

    check("720x1280 card scale", abs(ft.card_scale(720, 1280) - 2 / 3) < 1e-9, ft.card_scale(720, 1280))
    check("1080x1920 card scale", ft.card_scale(1080, 1920) == 1.0)
    check("720x1280 caption scale", abs(ft.caption_scale(720, 1280) - 0.31640625) < 1e-9, ft.caption_scale(720, 1280))

    # Widths from the font itself: "Smoke 1.41.0 vertical" at 80px ran off a 720 card in the smoke film.
    at_80 = ft.text_width(SMOKE_TITLE, 80)
    check("the smoke title at 80px is wider than 720", at_80 > 720, round(at_80))
    lines, size = ft.fit_title(SMOKE_TITLE, round(80 * ft.card_scale(720, 1280)), 720)
    check("the smoke title fits 720 on one line at 53", lines == [SMOKE_TITLE] and size == 53, (lines, size))
    check("and stays inside the margin", ft.text_width(SMOKE_TITLE, 53) <= 720 * ft.CARD_WIDTH_FRACTION)

    long_title = "The Very Long Name Of A Film That Somebody Really Did Type Into The Box"
    for w, h in VERTICAL + LANDSCAPE:
        lines, size = ft.fit_title(long_title, round(80 * ft.card_scale(w, h)), w)
        widest = max(ft.text_width(l, size) for l in lines)
        check(f"a long title stays on {w}x{h}", widest <= w and len(lines) <= ft.MAX_TITLE_LINES, (len(lines), size))
        check(f"no word is lost at {w}x{h}", " ".join(lines) == long_title)
    lines, size = ft.fit_title("Supercalifragilisticexpialidocious" * 2, 53, 720)
    check("one long word shrinks", len(lines) == 1 and ft.text_width(lines[0], size) <= 720 * ft.CARD_WIDTH_FRACTION, size)
    lines, size = ft.fit_title(" ".join(["Supercalifragilistic"] * 40), 53, 720)
    check("an absurd title still fits its width", all(ft.text_width(l, size) <= 720 for l in lines), (len(lines), size))
    lines, size = ft.fit_title("映画" * 30, 53, 720)
    check("CJK counts a full em and shrinks", ft.text_width(lines[0], size) <= 720, size)
    check("empty is safe", ft.fit_lines([], 48, 720) == 48)

    # The filters. app.py needs aiohttp, which container-tests installs. Not importing it is a failure, so a
    # broken import cannot pass this file with the landscape pins unchecked.
    try:
        import app
    except ImportError as e:
        app = None
        check(f"could not import app ({e})", False)
    if app is not None:
        for w, h in LANDSCAPE:
            check(f"title bytes unchanged at {w}x{h}", app._title_card_filter("My Film", width=w, height=h) == OLD_TITLE)
            check(f"title+sub bytes unchanged at {w}x{h}",
                  app._title_card_filter("My Film", subtitle="A Sub", width=w, height=h) == OLD_TITLE_SUB)
            check(f"credits bytes unchanged at {w}x{h}",
                  app._credits_card_filter(["One", "Two"], 8.0, width=w, height=h) == OLD_CREDITS)
            f = app._subtitle_filter("/s.srt", {"font": "DejaVu Sans", "fontSize": 28, "color": "white"}, w, h)
            check(f"caption style unchanged at {w}x{h}", OLD_CAPTION_STYLE in f, f)
        f = app._subtitle_filter("/s.srt", {"font": "DejaVu Sans", "fontSize": 28, "color": "white"})
        check("caption style unchanged with no frame", OLD_CAPTION_STYLE in f)

        t = app._title_card_filter("My Film", subtitle="A Sub", width=720, height=1280)
        check("720x1280 title 53", "fontsize=53:" in t, t)
        check("720x1280 subtitle 32", "fontsize=32:" in t)
        check("720x1280 gap 11", "y=(h/2+11)" in t and "y=(h/2-text_h-11)" in t)
        c = app._credits_card_filter(["One", "Two"], 8.0, width=720, height=1280)
        check("720x1280 credits 32 with spacing 13", "fontsize=32:" in c and "(h+90)" in c and "+45)" in c, c)
        v = app._subtitle_filter("/s.srt", {"font": "DejaVu Sans", "fontSize": 28, "color": "white"}, 720, 1280)
        check("720x1280 caption 8.9 with outline 0.6", "FontSize=8.9," in v and "Outline=0.6," in v, v)
        # The pure filters are no use if the work path does not hand them the frame.
        with open(app.__file__, encoding="utf-8") as src:
            source = src.read()
        check("title call site passes the frame", "_title_card_filter(text, subtitle=subtitle, width=width, height=height)" in source)
        check("credits call site passes the frame", "_credits_card_filter(lines, secs, width=width, height=height)" in source)
        check("the burn probes the film and passes the frame", "_probe_frame(film_path)" in source
              and "_subtitle_filter(srt_path, style, frame_w, frame_h)" in source)
        wrapped = app._title_card_filter(long_title, width=720, height=1280)
        check("a wrapped title draws one segment per line", wrapped.count("drawtext=") > 1, wrapped.count("drawtext="))
        check("a wrapped title has no overlapping lines", "y=((h-" in wrapped)

        # vivijure-cf#1218: a real render against textfile= is in test_local_frame_text.py. These pin its results.
        e = app._escape_drawtext
        check("an apostrophe goes through both parsers", e("Two O'Clock") == "Two O\\\\\\'Clock", e("Two O'Clock"))
        check("a colon goes through both parsers", e("a:b") == "a\\\\:b", e("a:b"))
        check("a backslash goes through both parsers", e("a\\b") == "a\\\\\\\\b", e("a\\b"))
        for char in ",;[]":
            check(f"graph character {char} is escaped", e(f"a{char}b") == f"a\\{char}b", e(f"a{char}b"))
        plain = app._title_card_filter("Two O'Clock", width=1920, height=1080)
        check("a title is not in quotes", "text='" not in plain, plain)
        check("a title is not expanded", "expansion=none" in plain, plain)
        credits_filter = app._credits_card_filter(["Mara's"], 4.0)
        check("a credit is not in quotes", "text='" not in credits_filter, credits_filter)
        check("a credit is not expanded", "expansion=none" in credits_filter, credits_filter)
        subtitled = app._title_card_filter("A", subtitle="B's", width=1920, height=1080)
        check("a subtitle is not in quotes", subtitled.count("text='") == 0, subtitled)
        check("a subtitle is not expanded", subtitled.count("expansion=none") == 2, subtitled)

    print(f"checks={checks} failed={len(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
