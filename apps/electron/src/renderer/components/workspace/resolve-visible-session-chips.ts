/**
 * 侧栏「打开中」芯片：只含主区当前看得见的会话（与 .row.is-open 同源）。
 * 分屏 = 各组 active pane；非分屏 = 当前激活 tab（不是整份 tabs 工作集）。
 */
export interface OpenRailTabChip {
  id: string
  sessionId: string
  title: string
}

export interface OpenRailTabRef {
  id: string
  sessionId: string
  title: string
}

export interface OpenRailVisibleSession {
  sessionId: string
  title: string
}

export function resolveVisibleSessionChips(input: {
  splitDockMode: boolean
  visibleSessions: OpenRailVisibleSession[]
  openTabs: OpenRailTabRef[]
  activeTabId: string | null
  activeSessionId: string | null
}): OpenRailTabChip[] {
  const { splitDockMode, visibleSessions, openTabs, activeTabId, activeSessionId } = input
  if (splitDockMode && visibleSessions.length > 0) {
    const titleByTabId = new Map(openTabs.map((t) => [t.sessionId, t.title]))
    return visibleSessions.map((v) => ({
      id: v.sessionId,
      sessionId: v.sessionId,
      title: titleByTabId.get(v.sessionId) ?? v.title,
    }))
  }
  const active =
    openTabs.find((t) => t.id === activeTabId) ??
    (activeSessionId ? openTabs.find((t) => t.sessionId === activeSessionId) : undefined)
  return active
    ? [{ id: active.id, sessionId: active.sessionId, title: active.title }]
    : []
}
