"""Generates EchoNote's icons. Requires Pillow.

- resources/icon.png (512 px) and resources/branding/echonote-1024.png: the app icon, made from
  echonote.png in the project root (white background made transparent, cropped, padded).
- resources/tray.png, resources/tray-recording.png: small monochrome tray icons.
"""
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


def app_icon() -> None:
    from collections import deque

    src = Image.open(os.path.join(OUT, '..', 'echonote.png')).convert('RGBA')
    w, h = src.size
    px = src.load()
    transparent = Image.new('L', (w, h), 0)
    mask = transparent.load()
    seen = bytearray(w * h)
    queue = deque([(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)])
    while queue:  # flood-fill the white background from the corners
        x, y = queue.popleft()
        if seen[y * w + x]:
            continue
        seen[y * w + x] = 1
        r, g, b, _ = px[x, y]
        if not (r > 235 and g > 235 and b > 235):
            continue
        mask[x, y] = 255
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx]:
                queue.append((nx, ny))
    alpha = Image.eval(transparent, lambda v: 255 - v)
    src.putalpha(alpha)
    cropped = src.crop(alpha.point(lambda v: 255 if v > 10 else 0).getbbox())
    side = max(cropped.size)
    pad = int(side * 0.06)
    final = Image.new('RGBA', (side + 2 * pad, side + 2 * pad), (0, 0, 0, 0))
    final.paste(cropped, (pad + (side - cropped.size[0]) // 2, pad + (side - cropped.size[1]) // 2), cropped)
    final.resize((1024, 1024), Image.LANCZOS).save(os.path.join(OUT, 'branding', 'echonote-1024.png'))
    final.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, 'icon.png'))


app_icon()
def indicator(size: int, kind: str) -> Image.Image:
    """Top-bar indicators: a plain red dot while recording, a green check right after."""
    s = size * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if kind == 'recording':
        r = s * 0.30
        d.ellipse([s / 2 - r, s / 2 - r, s / 2 + r, s / 2 + r], fill=(230, 40, 40, 255))
    else:
        r = s * 0.36
        d.ellipse([s / 2 - r, s / 2 - r, s / 2 + r, s / 2 + r], fill=(34, 160, 80, 255))
        w = max(3, int(s * 0.08))
        d.line([(s * 0.33, s * 0.52), (s * 0.45, s * 0.64), (s * 0.68, s * 0.38)], fill=(255, 255, 255, 255), width=w, joint='curve')
    return img.resize((size, size), Image.LANCZOS)


for name, kind in (('tray-recording', 'recording'), ('tray-done', 'done')):
    indicator(32, kind).save(os.path.join(OUT, f'{name}.png'))
    indicator(64, kind).save(os.path.join(OUT, f'{name}@2x.png'))
icon(32, tray=True).save(os.path.join(OUT, 'tray.png'))
print('icons written')
