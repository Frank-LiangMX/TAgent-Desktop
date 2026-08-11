# 侧栏「打开中」与分屏可见会话（2026-08-06）

> **状态**：已落地  
> **范围**：SessionSidebar open-rail / WorkspaceDock ↔ tabsAtom / 列表 is-open

## 契约

| 概念 | 真相源 | UI |
|------|--------|-----|
| 标签工作集 | `tabsAtom`（可含同组后台 tab） | Dockview 各 group 的 tab 条；关 tab 走 Dock × / TabBar × |
| 页面可见会话 | 分屏：`visibleSessionsAtom` = 各 `group.activePanel`；非分屏：当前 `activeTabId` 对应 tab | 侧栏「打开中」纵向芯片（**纯展示**，无点击/关闭） |
| 列表标注 | 与「打开中」同源（只标主区看得见的，不含后台 tab） | `.row.is-open` 玻璃底，**不再叠 is-active**；出错红点（`stat-dot.error`）只表示状态，不是打开态 |

## 同步要点

- reconcile：**dock 多出的 chat → 回填 tabs**；关 panel 由显式路径（`closeTab` + `dockApi.close`），不再「tabs 少就关 orphan」。
- 拖分屏误触发 `onDidRemovePanel`：延后一帧确认 + layout 回填，避免 tabs 丢会话。
- 已移除置顶（pin）UI；原置顶栏位改为打开中。

## 非目标

- 不在此恢复「最多 6 个 tab」硬上限（ADR-0002 设计意图，代码从未落地；见 ADR 已知缺口）。
- 分屏模式下不另挂全局 TabBar（与 Dock 组内 tab 重复）。
