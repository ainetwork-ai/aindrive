"""Draws desktop/assets: the app icon (1024 px, macOS rounded-square style)
and the menu-bar template icons (black + alpha, 16 px and @2x).

    python3 scripts/icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "assets"
OUT.mkdir(exist_ok=True)


def folder(draw, x, y, w, h, fill, r):
    tab_w, tab_h = w * 0.42, h * 0.16
    draw.rounded_rectangle([x, y, x + tab_w, y + tab_h * 2], radius=r, fill=fill)
    draw.rounded_rectangle([x, y + tab_h, x + w, y + h], radius=r, fill=fill)


def app_icon():
    S = 1024
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # soft shadow under the tile
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([100, 118, 924, 942], radius=185, fill=(0, 0, 0, 90))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))
    # tile: vertical blue gradient
    grad = Image.new("RGBA", (S, S))
    top, bottom = (66, 133, 244), (11, 87, 208)
    for yy in range(S):
        t = yy / S
        grad.putpixel((0, yy), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
    grad = grad.crop((0, 0, 1, S)).resize((S, S))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([100, 100, 924, 924], radius=185, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    # a white folder with a link dot: a folder, served
    folder(d, 262, 300, 500, 400, (255, 255, 255, 255), 44)
    d.ellipse([610, 560, 790, 740], fill=(11, 87, 208, 255))
    d.ellipse([632, 582, 768, 718], fill=(255, 255, 255, 255))
    d.rounded_rectangle([665, 636, 735, 664], radius=14, fill=(11, 87, 208, 255))
    d.rounded_rectangle([686, 615, 714, 685], radius=14, fill=(11, 87, 208, 255))
    img.save(OUT / "icon.png")
    # macOS icon set (electron-builder converts png with `sips`, which is macOS-only)
    img.save(OUT / "icon.icns", sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])


def tray(size, name):
    k = size / 16
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    folder(d, 1.5 * k, 3 * k, 13 * k, 10.5 * k, (0, 0, 0, 255), 1.6 * k)
    # cut a dot out of the corner: the "served" mark
    d.ellipse([9 * k, 8 * k, 14.5 * k, 13.5 * k], fill=(0, 0, 0, 0))
    d.ellipse([10.3 * k, 9.3 * k, 13.2 * k, 12.2 * k], fill=(0, 0, 0, 255))
    img.save(OUT / name)


app_icon()
tray(16, "trayTemplate.png")
tray(32, "trayTemplate@2x.png")
print("wrote", sorted(p.name for p in OUT.iterdir()))
