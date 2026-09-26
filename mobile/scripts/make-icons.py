"""Draws the Android launcher icon from the same shapes as the Mac app's
(desktop/scripts/icons.py: a white folder with a link dot on a blue tile), as an
adaptive icon (background + foreground layers, API 26+) plus legacy PNGs.

    python3 scripts/make-icons.py

The Android Studio template icon (the grey robot) shipped until 2026-09-27 because
nothing had ever replaced it.
"""
from pathlib import Path
from PIL import Image, ImageDraw

RES = Path(__file__).resolve().parent.parent / "android" / "app" / "src" / "main" / "res"
# dp → px per density bucket
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
TOP, BOTTOM = (66, 133, 244), (11, 87, 208)


def folder(draw, x, y, w, h, fill, r):
    tab_w, tab_h = w * 0.42, h * 0.16
    draw.rounded_rectangle([x, y, x + tab_w, y + tab_h * 2], radius=r, fill=fill)
    draw.rounded_rectangle([x, y + tab_h, x + w, y + h], radius=r, fill=fill)


def gradient(size):
    g = Image.new("RGBA", (1, size))
    for yy in range(size):
        t = yy / size
        g.putpixel((0, yy), tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,))
    return g.resize((size, size))


def glyph(size, scale=1.0):
    """The folder + link dot, drawn in a `size`-px square, centred; `scale` shrinks it (adaptive safe zone)."""
    S = 1024
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    folder(d, 262, 300, 500, 400, (255, 255, 255, 255), 44)
    d.ellipse([610, 560, 790, 740], fill=BOTTOM + (255,))
    d.ellipse([632, 582, 768, 718], fill=(255, 255, 255, 255))
    d.rounded_rectangle([665, 636, 735, 664], radius=14, fill=BOTTOM + (255,))
    d.rounded_rectangle([686, 615, 714, 685], radius=14, fill=BOTTOM + (255,))
    inner = int(size * scale)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.alpha_composite(img.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
    return out


def main():
    for name, k in DENSITIES.items():
        d = RES / f"mipmap-{name}"
        d.mkdir(exist_ok=True)
        # Adaptive layers are 108 dp; the launcher shows the middle 72 dp (66 dp safe), so the glyph is scaled to fit it.
        layer = int(108 * k)
        gradient(layer).save(d / "ic_launcher_background.png")
        glyph(layer, scale=72 / 108).save(d / "ic_launcher_foreground.png")
        # Legacy (pre-26) icons are 48 dp, full art: rounded square and circle.
        px = int(48 * k)
        art = gradient(px)
        art.alpha_composite(glyph(px, scale=0.86))
        for shape, fn in (("square", "ic_launcher.png"), ("round", "ic_launcher_round.png")):
            mask = Image.new("L", (px, px), 0)
            if shape == "square":
                ImageDraw.Draw(mask).rounded_rectangle([0, 0, px - 1, px - 1], radius=int(px * 0.2), fill=255)
            else:
                ImageDraw.Draw(mask).ellipse([0, 0, px - 1, px - 1], fill=255)
            out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
            out.paste(art, (0, 0), mask)
            out.save(d / fn)
    anydpi = RES / "mipmap-anydpi-v26"
    xml = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
           '    <background android:drawable="@mipmap/ic_launcher_background"/>\n'
           '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
           '</adaptive-icon>\n')
    (anydpi / "ic_launcher.xml").write_text(xml)
    (anydpi / "ic_launcher_round.xml").write_text(xml)
    # the template's layers are no longer referenced
    for stale in (RES / "drawable-v24" / "ic_launcher_foreground.xml", RES / "drawable" / "ic_launcher_background.xml"):
        if stale.exists():
            stale.unlink()
    print("launcher icons written under", RES)


if __name__ == "__main__":
    main()
