"""Size title cards, credits and burned captions for the frame the film is delivered at (cf#1111).

Stdlib only and pure, so container-tests can hold the numbers on a runner with no ffmpeg.

THE RULE. A frame at least as wide as it is tall keeps today's sizes, so landscape output does not
change. A vertical frame scales down. The one exception on landscape is text that would run off the
card, which wraps or shrinks on any frame.

CARDS are in real pixels: drawtext reads fontsize in pixels, so 80 is 80 at any frame. A vertical frame
scales by its short side against the 1080 these sizes were set for.

CAPTIONS are not in pixels. An SRT has no PlayRes, so libass uses a virtual height of 288 and FontSize 28
draws at 28/288 of the frame HEIGHT: about 105px at 1080 and 124px at 1280. Landscape is therefore
already proportional, and it is only a narrow tall frame that breaks: film-59918c13 at 720x1280 wrapped
one line of dialogue into six. The vertical factor is the frame's aspect against 16:9, which keeps the
same width in characters as a 16:9 film.
"""

LANDSCAPE_ASPECT = 16 / 9
REFERENCE_SHORT_SIDE = 1080
# A line may use this much of the frame. The rest is the margin that keeps it off the edge.
CARD_WIDTH_FRACTION = 0.94
MAX_TITLE_LINES = 3
MIN_FONT_SIZE = 12
LINE_HEIGHT_FACTOR = 1.25

# Advance widths of DejaVu Sans 2.35, the card font, in units of 1/2048 em, read from the font's hmtx
# table. Anything outside this range counts as a full em, which is right for CJK and errs towards
# shrinking for the rest.
_EM = 2048
_ADVANCE = dict(zip(
    " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
    (651, 821, 942, 1716, 1303, 1946, 1597, 563, 799, 799, 1024, 1716, 651, 739, 651, 690,
     1303, 1303, 1303, 1303, 1303, 1303, 1303, 1303, 1303, 1303, 690, 690, 1716, 1716, 1716, 1087,
     2048, 1401, 1405, 1430, 1577, 1294, 1178, 1587, 1540, 604, 604, 1343, 1141, 1767, 1532, 1612,
     1235, 1612, 1423, 1300, 1251, 1499, 1401, 2025, 1403, 1251, 1403, 799, 690, 799, 1716, 1024,
     1024, 1255, 1300, 1126, 1300, 1260, 721, 1300, 1298, 569, 569, 1186, 569, 1995, 1298, 1253,
     1300, 1300, 842, 1067, 803, 1298, 1212, 1675, 1212, 1212, 1075, 1303, 690, 1303, 1716),
))


def is_vertical(width, height):
    return width > 0 and height > 0 and width < height


def card_scale(width, height):
    """What a card's pixel sizes are multiplied by. 1.0 unless the frame is vertical."""
    if not is_vertical(width, height):
        return 1.0
    return width / REFERENCE_SHORT_SIDE


def caption_scale(width, height):
    """What a caption's libass sizes are multiplied by. 1.0 unless the frame is vertical."""
    if not is_vertical(width, height):
        return 1.0
    return (width / height) / LANDSCAPE_ASPECT


def text_width(text, font_size):
    """The drawn width of `text` in pixels at `font_size`, in DejaVu Sans, without kerning."""
    return sum(_ADVANCE.get(ch, _EM) for ch in text) * font_size / _EM


def _wrap(text, font_size, max_width):
    """Greedy word wrap. A single word wider than the line stays whole, and the caller shrinks it."""
    lines = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}" if current else word
        if current and text_width(candidate, font_size) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def fit_title(text, font_size, width):
    """(lines, font_size) that keep a title on a card `width` wide. Text that fits is returned as it
    came, at the size it came at. Otherwise it wraps first, up to MAX_TITLE_LINES, then shrinks."""
    max_width = width * CARD_WIDTH_FRACTION
    if text_width(text, font_size) <= max_width:
        return [text], font_size
    size = font_size
    while size > MIN_FONT_SIZE:
        lines = _wrap(text, size, max_width)
        if len(lines) <= MAX_TITLE_LINES and all(text_width(l, size) <= max_width for l in lines):
            return lines, size
        size -= 1
    lines = _wrap(text, MIN_FONT_SIZE, max_width)
    return lines, _shrink_to_fit(lines, MIN_FONT_SIZE, max_width)


def _shrink_to_fit(lines, font_size, max_width):
    """The largest whole size, at most `font_size`, at which every line fits. Never below 1."""
    widest = max((text_width(l, 1) for l in lines), default=0)
    if widest * font_size <= max_width:
        return font_size
    return max(1, int(max_width / widest))


def fit_lines(lines, font_size, width):
    """One size for a block of lines that do not wrap, such as credits or a card subtitle."""
    return _shrink_to_fit(lines, font_size, width * CARD_WIDTH_FRACTION)
