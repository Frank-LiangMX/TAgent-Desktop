# FIX — 关闭非当前会话标签会先跳过去（标签弹跳）

## 现象

开着会话 A 时点会话 B 的 ×：内容先切到 B 再关掉（底板/面板弹跳）。感觉「必须先跳到目标标签才能关」。

## 根因

Dockview 在 tab 的 pointerdown/mousedown 上会 `setActive`。自定义 `DockTab` 的 × 只在 `click` 上 `stopPropagation`，**未**在 pointerdown 上 `preventDefault`，官方 `DockviewDefaultTab` 的 close 按钮有 `onPointerDown → preventDefault`。

## 修法

`DockTab` / `TabBarItem` 关闭按钮：`pointerdown` + `mousedown` + `click` 均 `preventDefault` + `stopPropagation`，再 `api.close()` / `onClose()`。关非当前 tab 时不改 `activeTabId`（`closeTab` 已如此）。

## 验收

1. 停在 A，悬停 B 点 × → A 保持激活，B 消失，无内容/底板弹到 B。
2. 关当前 A → 切到相邻，行为不变。
3. 标签拖拽换序 / 边缘分屏仍可用。
