/**
 * Dockview api 句柄 + 页面上「可见会话」（每分屏组当前激活的 chat pane）。
 *
 * tabsAtom = 打开的标签工作集（可含同组后台 tab）；
 * visibleSessionsAtom = 主区实际露出的会话（3 分屏 ≈ 最多 3 条），侧栏「打开中」用它。
 */
import { atom } from 'jotai'
import type { DockviewApi, IDockviewPanel } from 'dockview'

export const dockApiAtom = atom<DockviewApi | null>(null)

export interface VisibleSession {
  sessionId: string
  title: string
}

/** 分屏主区当前可见的 chat 会话（按 group.activePanel；非会话 pane 跳过） */
export const visibleSessionsAtom = atom<VisibleSession[]>([])

const NON_SESSION_PREFIXES = ['crew:', 'file-preview:', 'mermaid-preview:', 'rich-preview:'] as const

function isNonSessionPaneId(id: string): boolean {
  return NON_SESSION_PREFIXES.some((prefix) => id.startsWith(prefix))
}

/** 从 Dockview 扫描各组当前激活 panel → 去重后的可见会话列表 */
export function collectVisibleSessions(api: DockviewApi): VisibleSession[] {
  const out: VisibleSession[] = []
  const seen = new Set<string>()
  for (const group of api.groups) {
    const panel = group.activePanel as IDockviewPanel | undefined
    if (!panel || isNonSessionPaneId(panel.id)) continue
    if (seen.has(panel.id)) continue
    seen.add(panel.id)
    out.push({
      sessionId: panel.id,
      title: panel.title || '会话',
    })
  }
  return out
}
