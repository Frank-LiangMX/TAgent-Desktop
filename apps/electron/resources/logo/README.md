# TAgent Logo

扁平定稿（原二十面体几何 + 提案 #19 风格）。

```
logo/
  appicon/          桌面图标（圆角底，四角透明）
    light.png       1024 · 浅色
    dark.png        1024 · 深色
  mark/             纯标（无底，背景透明）
    light.png       1024
    dark.png        1024
  tray/             托盘（背景透明，彩色标）
    color-light.png 32
    color-dark.png  32
  export_pngs.py
```

## 已接入 Desktop

| 用途 | 路径 |
| --- | --- |
| 窗口 / Dock 图标 | `main/index.ts` → `logo/appicon/{light,dark}.png`（跟系统明暗） |
| 安装包图标 | `electron-builder.yml` → `logo/appicon/light.png` |
| 关于页 logo | `renderer/assets/tagent-appicon-*.png`（带圆角底板） |
| 系统托盘 | `logo/tray/color-*.png`（`main/tray.ts`，跟主题浅深） |
| 便捷别名 | `resources/icon.png` = appicon/light |

托盘行为：关窗 = 隐藏；托盘左键打开；右键「退出 TAgent」真正退出。

Rail 导航列**不放 logo**（功能图标同构，品牌位在关于页 / 窗口图标）。

重新导出后请同步：

```bash
python apps/electron/resources/logo/export_pngs.py
copy apps\electron\resources\logo\appicon\light.png apps\electron\src\renderer\assets\tagent-appicon-light.png
copy apps\electron\resources\logo\appicon\dark.png  apps\electron\src\renderer\assets\tagent-appicon-dark.png
copy apps\electron\resources\logo\appicon\light.png apps\electron\resources\icon.png
```
