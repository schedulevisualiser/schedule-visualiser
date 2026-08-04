"""Regenerate img/og-image.png, the 1200x630 social preview card.

    python tools/make_og_image.py

Needs Pillow (`pip install Pillow`). The palette and the little network
diagram deliberately mirror css/home.css and the landing-page hero, so the
link preview looks like the page it opens.
"""

import os

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630

# straight out of css/home.css
BG = (249, 249, 247)
PANEL = (252, 252, 251)
BORDER = (225, 224, 217)
TEXT = (11, 11, 11)
MUTED = (82, 81, 78)
FAINT = (137, 135, 129)
ACCENT = (42, 120, 214)
CRITICAL = (208, 59, 59)
AQUA = (27, 175, 122)
VIOLET = (74, 58, 167)
AMBER = (237, 161, 0)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, os.pardir, "img", "og-image.png")

# Segoe UI first (what the site actually renders in), then portable fallbacks
FONT_DIRS = [r"C:\Windows\Fonts", "/usr/share/fonts/truetype/dejavu", "/Library/Fonts"]
FACES = {
    "bold": ["segoeuib.ttf", "DejaVuSans-Bold.ttf", "arialbd.ttf", "Arial Bold.ttf"],
    "semi": ["seguisb.ttf", "segoeuib.ttf", "DejaVuSans-Bold.ttf", "arialbd.ttf"],
    "regular": ["segoeui.ttf", "DejaVuSans.ttf", "arial.ttf", "Arial.ttf"],
}


def font(weight, size):
    for name in FACES[weight]:
        for d in FONT_DIRS:
            path = os.path.join(d, name)
            if os.path.exists(path):
                return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def blend(fg, bg, alpha):
    """Flatten a translucent fill against its background, so we can stay in RGB."""
    return tuple(round(f * alpha + b * (1 - alpha)) for f, b in zip(fg, bg))


def text_width(draw, s, f):
    return draw.textbbox((0, 0), s, font=f)[2]


def arrow(draw, p1, p2, colour, width):
    """Line with a solid triangular head, stopping short of the target node."""
    x1, y1 = p1
    x2, y2 = p2
    dx, dy = x2 - x1, y2 - y1
    length = max((dx * dx + dy * dy) ** 0.5, 1e-6)
    ux, uy = dx / length, dy / length
    head = 11
    bx, by = x2 - ux * head, y2 - uy * head  # base of the arrowhead
    draw.line([x1, y1, bx, by], fill=colour, width=width)
    px, py = -uy, ux  # perpendicular
    draw.polygon(
        [(x2, y2), (bx + px * 5.5, by + py * 5.5), (bx - px * 5.5, by - py * 5.5)],
        fill=colour,
    )


def node(draw, x, y, w, h, label, hue, critical=False):
    draw.rounded_rectangle(
        [x, y, x + w, y + h],
        radius=9,
        fill=blend(hue, PANEL, 0.13),
        outline=CRITICAL if critical else hue,
        width=3 if critical else 2,
    )
    f = font("semi", 15)
    draw.text(
        (x + w / 2 - text_width(draw, label, f) / 2, y + h / 2 - 11),
        label,
        font=f,
        fill=TEXT,
    )


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # accent rule down the left edge — the one flourish
    d.rectangle([0, 0, 7, H], fill=ACCENT)

    # ---- wordmark ----
    f_mark = font("semi", 31)
    d.text((72, 62), "Schedule ", font=f_mark, fill=TEXT)
    d.text((72 + text_width(d, "Schedule ", f_mark), 62), "Visualiser",
           font=f_mark, fill=ACCENT)

    # ---- headline ----
    f_h1 = font("bold", 57)
    d.text((72, 146), "See the logic behind", font=f_h1, fill=TEXT)
    d.text((72, 212), "your schedule.", font=f_h1, fill=ACCENT)

    # ---- subline ----
    f_sub = font("regular", 24)
    d.text((72, 306), "Trace the logic, follow the driving path and analyse",
           font=f_sub, fill=MUTED)
    d.text((72, 340), "the critical path of a P6 schedule — in your browser.",
           font=f_sub, fill=MUTED)

    # ---- chips ----
    f_chip = font("semi", 17)
    x = 72
    for label in ("No P6 licence", "Nothing uploaded", "WBS network map"):
        w = text_width(d, label, f_chip) + 30
        d.rounded_rectangle([x, 404, x + w, 444], radius=20,
                            fill=blend(ACCENT, BG, 0.10))
        d.text((x + 15, 414), label, font=f_chip, fill=ACCENT)
        x += w + 12

    # ---- url ----
    d.text((72, 522), "schedulevisualiser.com", font=font("semi", 23), fill=FAINT)

    # ---- network diagram panel ----
    px0, py0, px1, py1 = 656, 132, 1152, 498
    d.rounded_rectangle([px0, py0, px1, py1], radius=16, fill=PANEL,
                        outline=BORDER, width=2)

    # 3 columns of nw across the panel's inner width, evenly gapped
    nw, nh = 132, 46
    cols = (680, 838, 996)
    rows = (186, 278, 370)

    # edges first, so nodes sit on top of the arrowheads
    grey_w, red_w = 2, 3
    arrow(d, (cols[0] + nw, rows[0] + nh / 2), (cols[1] - 4, rows[1] + nh / 2),
          FAINT, grey_w)
    arrow(d, (cols[0] + nw, rows[2] + nh / 2), (cols[1] - 4, rows[1] + nh / 2),
          FAINT, grey_w)
    arrow(d, (cols[1] + nw, rows[1] + nh / 2), (cols[2] - 4, rows[0] + nh / 2),
          CRITICAL, red_w)
    arrow(d, (cols[1] + nw, rows[1] + nh / 2), (cols[2] - 4, rows[2] + nh / 2),
          FAINT, grey_w)

    node(d, cols[0], rows[0], nw, nh, "Site survey", VIOLET)
    node(d, cols[0], rows[2], nw, nh, "Long-lead order", AMBER)
    node(d, cols[1], rows[1], nw, nh, "Pile design", ACCENT, critical=True)
    node(d, cols[2], rows[0], nw, nh, "Piling", AQUA, critical=True)
    node(d, cols[2], rows[2], nw, nh, "Utilities", ACCENT)

    f_cap = font("regular", 15)
    cap = "critical path outlined in red"
    d.text(((px0 + px1) / 2 - text_width(d, cap, f_cap) / 2, py1 - 42),
           cap, font=f_cap, fill=FAINT)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    print("wrote %s (%dx%d, %.0f KB)"
          % (os.path.normpath(OUT), W, H, os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
