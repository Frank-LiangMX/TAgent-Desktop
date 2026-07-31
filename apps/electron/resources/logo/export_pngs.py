"""
Export TAgent logo masters into a clean tree:

  logo/appicon/{light,dark}.png     1024 rounded-rect, transparent corners
  logo/mark/{light,dark}.png        1024 mark only, transparent bg
  logo/tray/color-{light,dark}.png

Source geometry: TAgent_General tagent-logo-proposals-v2 light PNG.

Usage: python apps/electron/resources/logo/export_pngs.py
"""
from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent
APPICON = OUT / "appicon"
MARK = OUT / "mark"
TRAY = OUT / "tray"

SRC_LIGHT = Path(r"F:\TAgent_General\apps\electron\resources\tagent-logo-proposals-v2\tagent-default-light.png")

BG_LIGHT = (242, 243, 244, 255)
BG_DARK = (28, 31, 36, 255)

def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG", optimize=True)
    print(f"[OK] {path.relative_to(OUT)}")


def flood_background_mask(im: Image.Image, is_bg) -> Image.Image:
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    visited = bytearray(w * h)
    mask = Image.new("L", (w, h), 0)
    mp = mask.load()
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    q: deque[tuple[int, int]] = deque()
    for x, y in seeds:
        r, g, b, a = px[x, y]
        if is_bg(r, g, b, a):
            q.append((x, y))
            visited[y * w + x] = 1
    while q:
        x, y = q.popleft()
        mp[x, y] = 255
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if nx < 0 or ny < 0 or nx >= w or ny >= h:
                continue
            i = ny * w + nx
            if visited[i]:
                continue
            r, g, b, a = px[nx, ny]
            if not is_bg(r, g, b, a):
                continue
            visited[i] = 1
            q.append((nx, ny))
    return mask


def apply_remove_mask(im: Image.Image, bg_mask: Image.Image) -> Image.Image:
    out = im.convert("RGBA").copy()
    px, mp = out.load(), bg_mask.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            if mp[x, y] == 255:
                px[x, y] = (0, 0, 0, 0)
    return out


def extract_mark_light(src: Image.Image) -> Image.Image:
    def is_bg(r, g, b, a):
        if r >= 228 and g >= 228 and b >= 228:
            return True
        return r >= 210 and g >= 210 and b >= 210 and abs(r - g) < 10 and abs(g - b) < 10

    return apply_remove_mask(src, flood_background_mask(src, is_bg))


def make_flat_dark_from_light(mark_light: Image.Image) -> Image.Image:
    im = mark_light.convert("RGBA")
    w, h = im.size
    px = im.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    opx = out.load()
    ink = (232, 236, 240, 255)
    face = (37, 42, 48, 255)
    teal = (106, 150, 148, 255)
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 10:
                continue
            if g > r + 8 and abs(g - b) < 40 and g > 80 and r < 160:
                opx[x, y] = (teal[0], teal[1], teal[2], a if a < 200 else 255)
                continue
            lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
            if lum < 90:
                opx[x, y] = ink
            elif lum > 200:
                opx[x, y] = face
            else:
                t = (lum - 90) / 110
                opx[x, y] = (
                    int(ink[0] * (1 - t) + face[0] * t),
                    int(ink[1] * (1 - t) + face[1] * t),
                    int(ink[2] * (1 - t) + face[2] * t),
                    a,
                )
    return out


def trim_and_fit(mark: Image.Image, size: int, padding_ratio: float = 0.14) -> Image.Image:
    bbox = mark.split()[-1].getbbox()
    if not bbox:
        return Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cropped = mark.crop(bbox)
    pad = int(size * padding_ratio)
    inner = max(1, size - 2 * pad)
    cw, ch = cropped.size
    scale = min(inner / cw, inner / ch)
    nw, nh = max(1, int(cw * scale)), max(1, int(ch * scale))
    resized = cropped.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - nw) // 2, (size - nh) // 2), resized)
    return canvas


def compose_appicon(mark: Image.Image, bg: tuple[int, int, int, int], size: int = 1024) -> Image.Image:
    radius = size * (112 / 512)
    plate = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(plate).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=bg)
    m = mark.resize((size, size), Image.Resampling.LANCZOS) if mark.size != (size, size) else mark
    out = Image.alpha_composite(plate, m)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    r, g, b, a = out.split()
    a = Image.composite(a, Image.new("L", (size, size), 0), mask)
    return Image.merge("RGBA", (r, g, b, a))


def compose_tray_icon(
    mark: Image.Image,
    bg: tuple[int, int, int, int],
    size: int = 32,
    padding_ratio: float = 0.20,
) -> Image.Image:
    """
    托盘专用：圆角底板 + 加大内边距的 mark。

    Windows 浅色任务栏对「全透明 + 细几何」缩放很差，边缘糊成黑团。
    底板提供与系统栏对比稳定的缓冲色；padding 避免几何贴边被裁切。
    """
    # 先把 mark 裁进带 padding 的透明画布
    fitted = trim_and_fit(mark, size, padding_ratio=padding_ratio)
    # 圆角半径约 22%（小尺寸略圆，读得清）
    radius = max(2, int(size * 0.22))
    plate = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(plate).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=bg)
    out = Image.alpha_composite(plate, fitted)
    # 圆角裁切 alpha（防止直角像素在 16px 发糊）
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    r, g, b, a = out.split()
    a = Image.composite(a, Image.new("L", (size, size), 0), mask)
    return Image.merge("RGBA", (r, g, b, a))


def main() -> int:
    mark_l = extract_mark_light(Image.open(SRC_LIGHT))
    mark_d = make_flat_dark_from_light(mark_l)

    save(trim_and_fit(mark_l, 1024, 0.14), MARK / "light.png")
    save(trim_and_fit(mark_d, 1024, 0.14), MARK / "dark.png")

    save(compose_appicon(trim_and_fit(mark_l, 1024, 0.18), BG_LIGHT), APPICON / "light.png")
    save(compose_appicon(trim_and_fit(mark_d, 1024, 0.18), BG_DARK), APPICON / "dark.png")

    # 托盘：边缘必须留缓冲。全透明 + 8% 内边距时，Windows 浅色任务栏 16px 缩放
    # 会把密面几何糊成一团黑。这里加大 padding，并铺圆角底板（跟 appicon 同色），
    # 让图标在浅/深任务栏上都有「背景色缓冲」，不依赖系统主题抠透明。
    save(compose_tray_icon(mark_l, BG_LIGHT, size=32, padding_ratio=0.20), TRAY / "color-light.png")
    save(compose_tray_icon(mark_d, BG_DARK, size=32, padding_ratio=0.20), TRAY / "color-dark.png")
    # 16px 预烘焙（避免运行时二次缩小更糊）
    save(compose_tray_icon(mark_l, BG_LIGHT, size=16, padding_ratio=0.18), TRAY / "color-light-16.png")
    save(compose_tray_icon(mark_d, BG_DARK, size=16, padding_ratio=0.18), TRAY / "color-dark-16.png")

    print("\n[DONE]", OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
