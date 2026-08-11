# FIX-close-inactive-tab-bounce DONE

- `DockTab.tsx` / `TabBarItem.tsx`：关闭按钮 `pointerdown`/`mousedown`/`click` 均 `preventDefault` + `stopPropagation`，对齐官方 `DockviewDefaultTab`。
- 关非当前会话标签时不再先激活该面板，避免标签底板与主区内容弹跳。
