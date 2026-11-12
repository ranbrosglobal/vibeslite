#!/usr/bin/env python3
"""Generate the Vibes Lite PWA icon set for both frontends.

The mark is drawn geometrically (no font files, no network) so the icons are
fully reproducible: a black slab, an acid "V" cut from two heavy strokes, and a
bone baseline rule. Idempotent — safe to re-run at any time.

    .venv/bin/python tools/make_icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent

VOID = (7, 8, 10)
ACID = (203, 255, 60)
BONE = (234, 237, 230)

# (output path, pixel size, safe-area fraction) — the maskable variant keeps its
# artwork inside the centre 80% so Android's mask never clips the mark.
TARGETS = [
    ("crop-ai/public/icons/icon-192.png", 192, 1.0),
    ("crop-ai/public/icons/icon-512.png", 512, 1.0),
    ("crop-ai/public/icons/icon-maskable-512.png", 512, 0.78),
    ("crop-ai/public/icons/apple-touch-icon.png", 180, 0.92),
    ("frontend/public/icons/icon-192.png", 192, 1.0),
    ("frontend/public/icons/icon-512.png", 512, 1.0),
    ("frontend/public/icons/icon-maskable-512.png", 512, 0.78),
    ("frontend/public/icons/apple-touch-icon.png", 180, 0.92),
]

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Vibes Lite">
  <rect width="512" height="512" fill="#07080a"/>
  <rect x="26" y="26" width="460" height="460" fill="none" stroke="#cbff3c" stroke-width="12"/>
  <path d="M132 118 L256 392 L380 118 L316 118 L256 254 L196 118 Z" fill="#cbff3c"/>
  <rect x="196" y="410" width="120" height="22" fill="#eaede6"/>
  <rect x="398" y="398" width="42" height="42" fill="#cbff3c"/>
</svg>
"""


def draw_mark(size: int, safe: float) -> Image.Image:
    """Render the mark at `size` px, with artwork scaled into `safe` of the box."""
    img = Image.new("RGB", (size, size), VOID)
    d = ImageDraw.Draw(img)

    span = size * safe
    origin = (size - span) / 2
    u = span / 512.0  # design unit → px

    def box(x: float, y: float, w: float, h: float) -> list[float]:
        return [origin + x * u, origin + y * u, origin + (x + w) * u, origin + (y + h) * u]

    # Outer acid rule — the brutalist frame.
    d.rectangle(box(26, 26, 460, 460), outline=ACID, width=max(1, round(12 * u)))

    # The "V": two heavy strokes, drawn as one filled polygon.
    v = [
        (132, 118), (196, 118), (256, 254), (316, 118), (380, 118),
        (256, 392),
    ]
    d.polygon([(origin + x * u, origin + y * u) for x, y in v], fill=ACID)

    # Bone baseline rule.
    d.rectangle(box(196, 410, 120, 22), fill=BONE)
    # Solid accent block, top-right.
    d.rectangle(box(398, 398, 42, 42), fill=ACID)

    return img


def main() -> None:
    for rel, size, safe in TARGETS:
        out = ROOT / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        draw_mark(size, safe).save(out, "PNG", optimize=True)
        print(f"wrote {rel} ({size}x{size}, safe={safe})")

    for rel in ("crop-ai/public/icons/icon.svg", "frontend/public/icons/icon.svg"):
        out = ROOT / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(SVG, encoding="utf-8")
        print(f"wrote {rel}")


if __name__ == "__main__":
    main()
