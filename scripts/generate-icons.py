"""Generates the app and tray icons (PNG) used by EchoNote. Requires Pillow."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'resources')


def icon(size: int, recording: bool = False, tray: bool = False) -> Image.Image:
    s = size * 4  # supersample
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if not tray:
        # rounded square with indigo -> red diagonal gradient
        grad = Image.new('RGBA', (s, s))
        gd = ImageDraw.Draw(grad)
        for i in range(s):
            t = i / s
            c = (int(79 + (239 - 79) * t), int(70 + (68 - 70) * t), int(229 + (68 - 229) * t), 255)
            gd.line([(i, 0), (0, i)], fill=c, width=2)
            gd.line([(s - 1, i), (i, s - 1)], fill=c, width=2)
        mask = Image.new('L', (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=s // 5, fill=255)
        img.paste(grad, (0, 0), mask)
        fg = (255, 255, 255, 255)
    else:
        fg = (239, 68, 68, 255) if recording else (220, 220, 220, 255)
    # microphone glyph
    w = s * 0.22
    cx = s / 2
    d.rounded_rectangle([cx - w / 2, s * 0.18, cx + w / 2, s * 0.58], radius=w / 2, fill=fg)
    lw = max(2, int(s * 0.06))
    d.arc([cx - w * 1.05, s * 0.30, cx + w * 1.05, s * 0.70], start=0, end=180, fill=fg, width=lw)
    d.line([cx, s * 0.70, cx, s * 0.82], fill=fg, width=lw)
    d.line([cx - w * 0.7, s * 0.82, cx + w * 0.7, s * 0.82], fill=fg, width=lw)
    if recording:
        r = s * 0.14
        d.ellipse([s - 2 * r, 0, s, 2 * r], fill=(239, 68, 68, 255))
    return img.resize((size, size), Image.LANCZOS)


icon(512).save(os.path.join(OUT, 'icon.png'))
icon(32, tray=True).save(os.path.join(OUT, 'tray.png'))
icon(32, recording=True, tray=True).save(os.path.join(OUT, 'tray-recording.png'))
print('icons written')
