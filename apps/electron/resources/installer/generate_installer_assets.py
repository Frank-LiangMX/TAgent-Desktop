"""
TAgent 安装器品牌素材生成器（可复现）

从仓库已提交的品牌源素材生成 electron-builder NSIS 需要的安装器图片：
  - installerIcon.ico / uninstallerIcon.ico   多尺寸（256/128/64/48/32/16）
  - installerSidebar.bmp / uninstallerSidebar.bmp   164x314（欢迎/完成页侧图）
  - installerHeader.bmp   150x57（安装选项/目录/进度页页眉右侧小标）

设计取向：现代、克制、浅色原生桌面风格；沿用 export_pngs.py 的品牌色板与
logo/mark/light.png（浅底深标）。无随机性，幂等覆盖。

输入（均为已提交素材，相对脚本位置）：
  ../logo/appicon/light.png   1024 圆角底板应用图标（用于 .ico + 侧图/页眉「应用图标瓦」）
  ../logo/mark/light.png      1024 纯标（透明底，浅底用深墨+青绿，备用）

设计：直接复用 appicon（圆角底板 + 标）作为侧图/页眉的「应用图标瓦」，
与 .ico、关于页保持一致的品牌识别；浅底上标的白色面按品牌既有呈现
（黑描边 + 青绿面/对勾勾勒形状），与 app icon 本身观感一致。

运行：python apps/electron/resources/installer/generate_installer_assets.py
依赖：Pillow（与 resources/logo/export_pngs.py 同一工具链）
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent
LOGO = OUT.parent / "logo"

APPICON_LIGHT = LOGO / "appicon" / "light.png"
MARK_LIGHT = LOGO / "mark" / "light.png"

# 与 resources/logo/export_pngs.py 一致的品牌色板
TEAL = (106, 150, 148)        # 品牌青绿（强调色，#6A9694）

# 侧图浅冷渐变（与向导右侧白内容区有轻微分隔，且与 #F2F3F4 底板区分）
SIDEBAR_BG_TOP = (236, 240, 243)
SIDEBAR_BG_BOTTOM = (244, 246, 248)
SIDEBAR_TILE_OUTLINE = (214, 218, 223)  # 1px 瓦片描边，给 #F2F3F4 底板明确边界

# 页眉底色：与 NSIS 向导页眉区（白）融合，仅留小标
HEADER_BG = (255, 255, 255)

ICO_SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]

SIDEBAR_SIZE = (164, 314)
HEADER_SIZE = (150, 57)


def save_bmp(img: Image.Image, path: Path) -> None:
    """NSIS MUI 位图：24-bit 无压缩 BMP（无 alpha，侧图/页眉均为不透明底）。"""
    img.convert("RGB").save(path, format="BMP")
    print(f"[OK] {path.relative_to(OUT)}  {img.size[0]}x{img.size[1]}")


def save_ico(img: Image.Image, path: Path) -> None:
    """多尺寸安装器图标（保留圆角透明角）：先 LANCZOS 降到 256，再内嵌各尺寸。"""
    base = img.resize((256, 256), Image.Resampling.LANCZOS)
    base.save(path, format="ICO", sizes=ICO_SIZES)
    print(f"[OK] {path.relative_to(OUT)}  ico sizes={ICO_SIZES}")


def _vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(h):
        t = y / (h - 1)
        r = round(top[0] * (1 - t) + bottom[0] * t)
        g = round(top[1] * (1 - t) + bottom[1] * t)
        b = round(top[2] * (1 - t) + bottom[2] * t)
        row = (r, g, b)
        for x in range(w):
            px[x, y] = row
    return img


def make_sidebar(appicon: Image.Image, size: tuple[int, int] = SIDEBAR_SIZE) -> Image.Image:
    """
    欢迎页 / 完成页左侧品牌图：浅冷渐变底 + 左侧青绿强调条 + 居中「应用图标瓦」。
    用 appicon（圆角底板 + 标）本身作瓦，与 .ico/关于页同源；1px 描边给底板明确边界。
    无文字（文案由 MUI 在右侧以系统字体渲染，避免位图字体不可复现）。
    """
    w, h = size
    img = _vertical_gradient(size, SIDEBAR_BG_TOP, SIDEBAR_BG_BOTTOM)
    # 左侧青绿强调条：现代克制的一抹品牌色
    ImageDraw.Draw(img).rectangle((0, 0, 5, h - 1), fill=TEAL)

    tile = 132
    radius = round(tile * 112 / 512)  # 与 appicon 圆角比例一致
    ox = (w - tile) // 2
    oy = 70
    # 描边先画在底板上，再贴 appicon（其不透明 #F2F3F4 底板会覆盖内部，描边在边缘露出 1px）
    ImageDraw.Draw(img).rounded_rectangle(
        (ox, oy, ox + tile - 1, oy + tile - 1), radius=radius, outline=SIDEBAR_TILE_OUTLINE, width=1
    )
    a = appicon.resize((tile, tile), Image.Resampling.LANCZOS)
    img.paste(a, (ox, oy), a)
    return img


def make_header(appicon: Image.Image, size: tuple[int, int] = HEADER_SIZE) -> Image.Image:
    """
    安装选项 / 目录 / 进度页页眉右侧小标（MUI_HEADERIMAGE_RIGHT）：
    白底 + 右对齐「应用图标瓦」（与侧图同源，缩小版）。与向导页眉区融合。
    """
    w, h = size
    img = Image.new("RGB", size, HEADER_BG)
    tile = 40
    a = appicon.resize((tile, tile), Image.Resampling.LANCZOS)
    ox = w - 12 - tile
    oy = (h - tile) // 2
    img.paste(a, (ox, oy), a)
    return img


def main() -> int:
    appicon = Image.open(APPICON_LIGHT).convert("RGBA")

    OUT.mkdir(parents=True, exist_ok=True)

    save_ico(appicon, OUT / "installerIcon.ico")
    save_ico(appicon, OUT / "uninstallerIcon.ico")

    save_bmp(make_sidebar(appicon), OUT / "installerSidebar.bmp")
    save_bmp(make_sidebar(appicon), OUT / "uninstallerSidebar.bmp")
    save_bmp(make_header(appicon), OUT / "installerHeader.bmp")

    print("\n[DONE]", OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
