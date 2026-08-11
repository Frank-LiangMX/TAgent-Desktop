# FIX：侧栏「打开中」只显示当前看得见的会话 — DONE

> 日期：2026-08-11  
> brief：`FIX-sidebar-open-rail-visible-only-brief.md`

## 结论

非分屏下 `open-rail` / `.row.is-open` 不再用整份 `tabsAtom`，只保留当前激活可见 tab。分屏仍用 `visibleSessions`。出错红点与打开态解耦（红点≠选择态）。

## 改动

| 文件 | 说明 |
| --- | --- |
| `resolve-visible-session-chips.ts` | 纯函数入选逻辑 |
| `resolve-visible-session-chips.test.ts` | 4 项单测 |
| `SessionSidebar.tsx` | 改用纯函数；aria-label「当前可见会话」 |
| `2026-08-06-sidebar-visible-sessions.md` | 契约同步 |

## 验收

- `bunx vitest run src/renderer/components/workspace/resolve-visible-session-chips.test.ts` ✅
- 人工：双 tab 时仅当前主区会话登顶 + `is-open`；后台出错会话仅红点无玻璃底
