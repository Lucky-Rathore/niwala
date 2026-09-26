#!/usr/bin/env python3
"""Draw the Niwala logo and write every app icon VS Code's build expects.

Geometry and colors were measured from the original 2048px logo artwork.
Run from anywhere: python3 branding/generate-icons.py  (requires Pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "vscode" / "resources"

NAVY = (35, 45, 98, 255)
BLUE = (46, 108, 209, 255)
GOLD = (224, 185, 118, 255)

# Coordinates on a 1000-unit canvas.
CORNER_RADIUS = 218
STROKE = 76
LEFT_CHEVRON = [(399, 288), (189, 500), (399, 712)]
RIGHT_CHEVRON = [(1000 - x, y) for x, y in LEFT_CHEVRON]
DOT_CENTER, DOT_RADIUS = (500, 500), 125


def draw(size: int, inset: float = 0.0) -> Image.Image:
    """Render at 4x and downsample for anti-aliasing. `inset` pads the tile (macOS icon grid)."""
    ss = size * 4
    img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = ss * inset
    scale = (ss - 2 * pad) / 1000

    def p(x: float, y: float) -> tuple[float, float]:
        return (pad + x * scale, pad + y * scale)

    d.rounded_rectangle([p(0, 0), p(1000, 1000)], radius=CORNER_RADIUS * scale, fill=NAVY)

    width = STROKE * scale
    for chevron in (LEFT_CHEVRON, RIGHT_CHEVRON):
        d.line([p(*pt) for pt in chevron], fill=BLUE, width=round(width), joint="curve")
        for pt in chevron:  # round caps and join
            cx, cy = p(*pt)
            d.ellipse([cx - width / 2, cy - width / 2, cx + width / 2, cy + width / 2], fill=BLUE)

    cx, cy = p(*DOT_CENTER)
    r = DOT_RADIUS * scale
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    master = draw(1024)
    master.save(ROOT / "branding" / "niwala-1024.png")

    # Linux
    master.save(RES / "linux" / "code.png")

    # Server / web
    draw(192).save(RES / "server" / "code-192.png")
    draw(512).save(RES / "server" / "code-512.png")
    master.save(RES / "server" / "favicon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64)])

    # Windows
    master.save(RES / "win32" / "code.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    draw(70).save(RES / "win32" / "code_70x70.png")
    draw(150).save(RES / "win32" / "code_150x150.png")

    # macOS: Apple's icon grid leaves ~10% transparent margin around the tile.
    draw(1024, inset=0.1).save(RES / "darwin" / "code.icns")

    print("Icons written under", RES)


if __name__ == "__main__":
    main()
