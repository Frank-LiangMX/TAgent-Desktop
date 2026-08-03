/**
 * WorkspaceDock — Dockview 分屏工作台宿主（实验，splitDockModeAtom 开启时渲染）。
 *
 * 数据流：
 * - tabsAtom 是「哪些会话打开」的真相源；Dockview 管 layout（分屏方向/group 树）。
 * - tabsAtom → api：新 TabItem → api.addPanel（id=sessionId, component:'chat'）；
 *   TabItem 移除 → api.getPanel(id)?.close()。幂等守卫防重复 add。
 * - api → tabsAtom：用户点 Dockview tab × 关 panel → onDidRemovePanel → closeTab；
 *   isReconciling ref 防回环（我们主动 close 触发的 remove 不再改 tabsAtom）。
 * - 拖 tab 到边缘分屏只动 Dockview 内部 layout，不碰 tabsAtom（分屏是布局不是开关）。
 * - onDidActivePanelChange → setActiveTabIdAtom 软同步（侧栏高亮等用）。
 *
 * 多 Chat 并存已验证安全：Chat 流式事件按 sessionIdRef 过滤（Chat.tsx:868）。
 */
import { useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { DockviewReact } from 'dockview-react'
import type { DockviewApi, IDockviewPanel, Position, SerializedDockview } from 'dockview'
import { themeAbyss } from 'dockview'
import 'dockview/dist/styles/dockview.css'
import './dock.css'
import { ChatPane } from './ChatPane'
import { CrewPane } from './CrewPane'
import { DockTab } from './DockTab'
import { tabsAtom, activeTabIdAtom, closeTab, type TabItem } from '../../atoms/tabs'

const DOCK_LAYOUT_KEY = 'tagent:dockLayout'

/**
 * Dockview 主题：默认 themeAbyss 的 dndOverlayMounting 走 'relative' → 根 drop target
 * 被禁用 → 拖 tab 到容器上下边缘有指示器但不分屏（只有 group 内 overlay）。
 * 显式设 'absolute' 启用根 drop target，四向（上下左右）边缘吸附分屏均生效。
 */
const dockTheme = { ...themeAbyss, dndOverlayMounting: 'absolute' } as const

/** Position → Direction（用于 addGroup 在 referenceGroup 旁新建分屏 group） */
const POS_TO_DIR: Record<Exclude<Position, 'center'>, 'above' | 'below' | 'left' | 'right'> = {
  top: 'above',
  bottom: 'below',
  left: 'left',
  right: 'right',
}

/**
 * 单 panel group 拖自己 tab 到 content 边缘时，Dockview 走 _doMoveGroupOrPanel 的
 * moveView(同位置) 分支 = no-op 不分屏。这里拦截 onWillDrop：preventDefault 后
 * addGroup({ referenceGroup, direction }) 在目标方向新建空 group，再把 panel
 * moveTo 过去 → 真正分屏。多 tab group（size>=2）不拦截，Dockview 原生能拆出单 tab。
 */
function handleWillDropForEdgeSplit(e: {
  kind: string
  position: Position
  group?: { id: string; size: number } | null
  getData: () => { panelId: string | null; groupId: string } | undefined
  preventDefault: () => void
  nativeEvent: { defaultPrevented: boolean }
  api: DockviewApi
}): void {
  if (e.kind !== 'content') return
  if (e.position === 'center') return
  const group = e.group
  // 仅单 panel group 同源会 no-op；多 tab 让 Dockview 原生处理
  if (!group || group.size !== 1) return
  const data = e.getData()
  if (!data || !data.panelId) return
  if (data.groupId !== group.id) return // 拖到别的 group 边缘，Dockview 原生能分
  e.preventDefault()
  const dir = POS_TO_DIR[e.position as Exclude<Position, 'center'>]
  const newGroup = e.api.addGroup({ referenceGroup: group.id, direction: dir })
  const panel = e.api.getPanel(data.panelId)
  if (panel) panel.api.moveTo({ group: newGroup, position: 'center' })
}

export function WorkspaceDock(): JSX.Element {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  const apiRef = useRef<DockviewApi | null>(null)
  const [apiReady, setApiReady] = useState(false)
  const isReconcilingRef = useRef(false)
  // activeTabId 闭包会过期（事件订阅 effect 只挂一次），用 ref 保最新值供 remove 回调用
  const activeTabIdRef = useRef<string | null>(activeTabId)
  activeTabIdRef.current = activeTabId

  // tabsAtom → api：增删 panel 与 tabs 对齐（api 就绪后 / tabs 变更都跑）
  useEffect(() => {
    const api = apiRef.current
    if (!api || !apiReady) return
    isReconcilingRef.current = true
    try {
      const currentIds = new Set<string>()
      api.panels.forEach((p: IDockviewPanel) => currentIds.add(p.id))

      // 新增 tabs：addPanel（幂等，已存在跳过并同步标题）
      for (const tab of tabs) {
        if (currentIds.has(tab.sessionId)) {
          currentIds.delete(tab.sessionId)
          const existing = api.getPanel(tab.sessionId)
          if (existing && existing.title !== tab.title) existing.setTitle?.(tab.title)
          continue
        }
        api.addPanel({
          id: tab.sessionId,
          title: tab.title || '会话',
          component: 'chat',
          params: { sessionId: tab.sessionId, paneType: 'chat' },
        })
      }

      // 残留 panel（tabs 已无）→ 关闭（panel.api.close()）
      for (const orphanId of currentIds) {
        const orphan = api.getPanel(orphanId)
        if (orphan) orphan.api.close()
      }
    } finally {
      isReconcilingRef.current = false
    }
  }, [tabs, apiReady])

  // 事件订阅：api 就绪时挂，卸载时清（onReady 回调返回值会被 Dockview 忽略，故用 effect）
  useEffect(() => {
    const api = apiRef.current
    if (!api || !apiReady) return

    // 用户在 Dockview 关 panel → 同步 tabsAtom（非我们 reconcile 触发的）
    const dRemove = api.onDidRemovePanel((panel: IDockviewPanel) => {
      if (isReconcilingRef.current) return
      const sessionId = panel.id
      setTabs((prev: TabItem[]) => {
        if (!prev.some((t) => t.sessionId === sessionId)) return prev
        const { tabs: next, activeTabId: nextActive } = closeTab(
          prev,
          activeTabIdRef.current,
          sessionId,
        )
        setActiveTabId(nextActive)
        return next
      })
    })

    // Dockview 激活 panel → 软同步 activeTabIdAtom（侧栏高亮等用）
    const dActive = api.onDidActivePanelChange((evt) => {
      if (isReconcilingRef.current) return
      const panel = (evt as { panel?: IDockviewPanel }).panel
      if (panel) setActiveTabId(panel.id)
    })

    // 根 drop target 的 canDisplayOverlay 对非 center 位置返回 onUnhandledDragOver 的 isAccepted，
    // 而 AcceptableEvent 默认 false → 根边缘 overlay 不显示，拖 tab 到画布上下/左右外缘只命中
    // group 内 overlay（走 onMove，单 group 同源 = no-op 不分屏）。
    // 这里对 'edge' 的四向位置 accept()，让根 drop target 接管边缘 drop → orthogonalize 新建分屏 group。
    const dUnhandled = api.onUnhandledDragOver((evt) => {
      if (evt.target === 'edge' && evt.position !== 'center') {
        evt.accept()
      }
    })

    // 布局持久化：布局变化（拖拽分屏/调宽/关 panel）后存 toJSON 到 localStorage，重启恢复。
    // 节流：拖拽中 onDidLayoutChange 频繁触发，用 rAF 合并，避免每个像素都写。
    let rafId: number | null = null
    const persist = (): void => {
      if (rafId != null) return
      rafId = window.requestAnimationFrame(() => {
        rafId = null
        try {
          localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(api.toJSON()))
        } catch {
          /* 存储失败（配额/隐私模式）忽略 */
        }
      })
    }
    const dLayout = api.onDidLayoutChange(() => persist())

    return () => {
      dRemove.dispose()
      dActive.dispose()
      dUnhandled.dispose()
      dLayout.dispose()
      if (rafId != null) window.cancelAnimationFrame(rafId)
      // 卸载时最后存一次（关 flag / 切走）
      try {
        localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(api.toJSON()))
      } catch {
        /* 忽略 */
      }
    }
  }, [apiReady, setTabs, setActiveTabId])

  const handleReady = (e: { api: DockviewApi }): void => {
    apiRef.current = e.api
    // 恢复持久化的分屏布局（含 crew pane 的 sessionId 关联，GroupviewPanelState.params 保留）
    try {
      const raw = localStorage.getItem(DOCK_LAYOUT_KEY)
      if (raw) {
        const layout = JSON.parse(raw) as SerializedDockview
        e.api.fromJSON(layout)
      }
    } catch {
      /* layout 损坏则丢弃，走空 dock + reconcile 重建 */
    }
    setApiReady(true) // 触发下面两个 effect 首次 reconcile（补 layout 没有的新 tab）+ 挂事件
  }

  /** 开班组面板：绑定当前活跃会话，分屏到活跃 panel 右侧（选项 B：面板绑定会话） */
  const openCrewForActive = (): void => {
    const api = apiRef.current
    if (!api) return
    const active = api.activePanel
    if (!active) return
    const sessionId = active.id // chat panel id = sessionId
    const sessionTitle = tabs.find((t) => t.sessionId === sessionId)?.title ?? sessionId
    // 已有该会话的 crew pane 则聚焦，不重复开（保证一会话最多一个班组面板，标识不乱）
    const crewId = `crew:${sessionId}`
    const existing = api.getPanel(crewId)
    if (existing) {
      existing.api.setActive?.()
      return
    }
    api.addPanel({
      id: crewId,
      title: `班组 · ${sessionTitle}`,
      component: 'crew',
      params: { sessionId, sessionTitle, paneType: 'crew' },
      position: { direction: 'right', referencePanel: active },
    })
  }

  return (
    <div className="workspace-dock h-full min-h-0">
      <DockviewReact
        onReady={handleReady}
        components={{ chat: ChatPane, crew: CrewPane }}
        defaultTabComponent={DockTab}
        theme={dockTheme}
        onWillDrop={handleWillDropForEdgeSplit}
        className="workspace-dock__canvas"
      />
      {/* 浮动开班组按钮（右上角）：开一个绑定当前活跃会话的 crew pane */}
      <button
        type="button"
        className="workspace-dock__open-crew"
        onClick={openCrewForActive}
        aria-label="为当前会话开班组面板"
        title="为当前会话开班组面板（可分屏）"
      >
        + 班组
      </button>
    </div>
  )
}
