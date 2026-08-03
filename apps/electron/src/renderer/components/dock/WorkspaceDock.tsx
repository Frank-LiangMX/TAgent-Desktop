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
import type { DockviewApi, IDockviewPanel } from 'dockview'
import { themeAbyss } from 'dockview'
import 'dockview/dist/styles/dockview.css'
import './dock.css'
import { ChatPane } from './ChatPane'
import { tabsAtom, activeTabIdAtom, closeTab, type TabItem } from '../../atoms/tabs'

/**
 * Dockview 主题：默认 themeAbyss 的 dndOverlayMounting 走 'relative' → 根 drop target
 * 被禁用 → 拖 tab 到容器上下边缘有指示器但不分屏（只有 group 内 overlay）。
 * 显式设 'absolute' 启用根 drop target，四向（上下左右）边缘吸附分屏均生效。
 */
const dockTheme = { ...themeAbyss, dndOverlayMounting: 'absolute' } as const

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
          params: { sessionId: tab.sessionId },
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

    return () => {
      dRemove.dispose()
      dActive.dispose()
      dUnhandled.dispose()
    }
  }, [apiReady, setTabs, setActiveTabId])

  const handleReady = (e: { api: DockviewApi }): void => {
    apiRef.current = e.api
    setApiReady(true) // 触发上面两个 effect 首次 reconcile + 挂事件
  }

  return (
    <div className="workspace-dock h-full min-h-0">
      <DockviewReact
        onReady={handleReady}
        components={{ chat: ChatPane }}
        theme={dockTheme}
        className="workspace-dock__canvas"
      />
    </div>
  )
}
