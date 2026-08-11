# Brief：侧栏「打开中」只显示当前看得见的会话

> 日期：2026-08-11  
> 执行：本地 `kscc / glm-5.2` 或主线窄修

## 现象

非分屏下顶部 `open-rail` 与列表 `.row.is-open` 用整份 `tabsAtom` 工作集，后台 tab（主区未露出）也会登顶、行上出现玻璃「打开」底。用户易把这当成「活跃/选中」，并与出错红点混淆。

## 根因

`SessionSidebar` 的 `activeSessionChips`：分屏走 `visibleSessions`（正确）；非分屏回退 `openTabs` 全量（错误）。`openSessionIds` / `is-open` 与 chips 同源。

红点（`stat-dot.error`）只表示出错状态，不是选择态。

## 修复

非分屏时 chips / `is-open` 只保留当前激活可见会话：`activeTabId` 对应 tab（必要时回退 `activeSessionId`）。分屏逻辑不变。`tabsAtom` 工作集、顶栏多 tab 不变。

## 验收

1. 开 2 个 tab、主区只显示 A → open-rail 仅 A；仅 A 行有 `is-open`。
2. 切到 B → chips / `is-open` 跟上 B。
3. B 为 error：仅红点，无玻璃底（除非 B 正是当前可见）。
4. 分屏：仍按各组 `activePanel` 多芯片。
5. 相关单测 / `git diff --check` 通过。

## 不做

不改成「仅 running」过滤；不改 tab 持久化；不给 open-rail 加点击/关闭。

## 验收结论（DONE · 2026-08-11）

主线 `SessionSidebar.tsx` 改动符合本 brief，非分屏 `activeSessionChips` 只保留当前激活 tab（`activeTabId` 对应 tab，缺失时回退 `activeSessionId`），分屏仍走 `visibleSessions`；`openSessionIds` / `.row.is-open` 与芯片同源；`open-rail` 的 `aria-label` 已改为「当前可见会话」；注释同步为「非分屏=当前激活 tab」。`tabsAtom` 工作集、顶栏多 tab、点击/关闭行为均未改。

验收点逐条：

1. 开 2 个 tab、主区只显示 A → 芯片仅 A、仅 A 行 `is-open`：✅（`resolve-visible-session-chips.test.ts`「只保留当前激活 tab，后台 tab 不登顶」）
2. 切到 B → 芯片 / `is-open` 跟上 B：✅（同函数按 `activeTabId` 投影，切 tab 即切芯片；回退 `activeSessionId` 用例覆盖 B 登顶）
3. B 为 error 且非当前可见 → 仅红点、无玻璃底：✅（B 不在芯片即无 `is-open`；红点由 `statusOf` 另算。测试 tabs 含「会话 B（出错）」，激活 a 时断言芯片只含 a）
4. 分屏仍按各组 `activePanel` 多芯片：✅（`splitDockMode && visibleSessions.length>0` 分支；测试「按 visibleSessions，可多芯片」）
5. 单测 / `git diff --check`：✅

为可测性抽出纯函数 `resolveVisibleSessionChips`（`resolve-visible-session-chips.ts`，入参用结构性类型 `OpenRailTabRef` / `OpenRailVisibleSession`，不耦合 `tabsAtom` / `dock-api` 运行时），`SessionSidebar` 改为调用它；新增 `resolve-visible-session-chips.test.ts` 4 例。

改动文件：

- `apps/electron/src/renderer/components/workspace/SessionSidebar.tsx`（导入并调用 `resolveVisibleSessionChips`，移除内联 IIFE 与局部 `titleByTabId`，`aria-label` → 「当前可见会话」，注释同步）
- `apps/electron/src/renderer/components/workspace/resolve-visible-session-chips.ts`（新，纯函数）
- `apps/electron/src/renderer/components/workspace/resolve-visible-session-chips.test.ts`（新，单测）

验证：`vitest run` 4 例 + 既有 `session-sidebar-archived.test.ts` 9 例全绿；`tsc --noEmit` 通过；`git diff --check` 退出 0。
