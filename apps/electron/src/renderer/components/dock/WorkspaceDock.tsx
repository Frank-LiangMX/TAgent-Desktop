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
import { mountDockActivePlates } from './dockActivePlate'
import { tabsAtom, activeTabIdAtom, closeTab, type TabItem } from '../../atoms/tabs'

const DOCK_LAYOUT_KEY = 'tagent:dockLayout'

/**
 * Dockview 主题：
 * - dndOverlayMounting:'absolute'：启用根 drop target，四向边缘分屏
 * - dndTabIndicator:'line'：换序指示器是 tab 边缘 4px 竖条（正常 tab 系统「插在中间」），
 *   默认 'fill' 会在 tab 内对半高亮，体验像把 tab 切开
 */
const dockTheme = {
  ...themeAbyss,
  dndOverlayMounting: 'absolute',
  dndTabIndicator: 'line',
} as const

/** Position → Direction（用于 addGroup 在 referenceGroup 旁新建分屏 group） */
const POS_TO_DIR: Record<Exclude<Position, 'center'>, 'above' | 'below' | 'left' | 'right'> = {
  top: 'above',
  bottom: 'below',
  left: 'left',
  right: 'right',
}

/** WillDrop 上可能有的目标 group / 落点 tab（Dockview 类型略松） */
type WillDropGroup = {
  id: string
  size: number
  panels: ReadonlyArray<{ id: string }>
}
type WillDropPanel = { id: string }

/**
 * 解析标签栏插入下标。
 * Dockview handleDropEvent：kind=tab 时 e.panel = panels[insertionIndex]（插到该下标前）；
 * 插到末尾时 insertionIndex === size → e.panel 为 undefined。
 * header_space / 无 panel → 末尾。
 * 额外：若带 clientX 且落在「当前最后一枚 tab」右半，强制 append（防右半被 × 挡住时
 * dock 仍把落点算成 last 本身）。
 */
function resolveTabInsertIndex(
  e: {
    kind: string
    panel?: WillDropPanel
    nativeEvent?: { clientX?: number; target?: EventTarget | null }
  },
  dest: WillDropGroup,
): number {
  if (e.kind === 'header_space' || !e.panel) return dest.size
  const i = dest.panels.findIndex((p) => p.id === e.panel!.id)
  if (i < 0) return dest.size

  // 落在最后一枚 tab 上：用坐标判断左半=插到它前，右半=append 到末尾
  if (i === dest.size - 1 && e.nativeEvent?.clientX != null) {
    const t = e.nativeEvent.target
    const tabEl =
      t instanceof Element ? t.closest?.('.dv-tab') : null
    if (tabEl) {
      const rect = tabEl.getBoundingClientRect()
      if (e.nativeEvent.clientX >= rect.left + rect.width / 2) {
        return dest.size // 右半 → 插到最后
      }
    }
  }
  return i
}

/**
 * 拖放策略：
 * - tab / header_space（含跨分屏、同组换序、插到末尾）→ 显式 moveTo
 * - content 中心 → 禁止
 * - content 边缘 → 分屏；单 tab 同源 no-op 时拦截后 addGroup+moveTo
 */
function handleWillDrop(e: {
  kind: string
  position: Position
  group?: WillDropGroup | null
  panel?: WillDropPanel
  nativeEvent?: { clientX?: number; target?: EventTarget | null }
  getData: () => { panelId: string | null; groupId: string } | undefined
  preventDefault: () => void
  api: DockviewApi
}): void {
  const data = e.getData()
  const dest = e.group

  // —— 标签栏落点：一律显式 move（跨组并入 + 同组换序 + 插末尾）——
  if ((e.kind === 'tab' || e.kind === 'header_space') && data?.panelId && dest) {
    e.preventDefault()
    const panel = e.api.getPanel(data.panelId)
    if (!panel) return
    // 拖到自己所在位置 no-op
    if (data.groupId === dest.id && dest.panels.length === 1) return
    const index = resolveTabInsertIndex(e, dest)
    panel.api.moveTo({ group: dest as never, position: 'center', index })
    return
  }

  // 禁止拖进消息区中部
  if (e.kind === 'content' && e.position === 'center') {
    e.preventDefault()
    return
  }

  // 单 tab 同源边缘分屏（修复原生 moveView 同位置 no-op）
  if (e.kind !== 'content') return
  if (!dest || dest.size !== 1) return
  if (!data?.panelId) return
  if (data.groupId !== dest.id) return
  e.preventDefault()
  const dir = POS_TO_DIR[e.position as Exclude<Position, 'center'>]
  const newGroup = e.api.addGroup({ referenceGroup: dest.id, direction: dir })
  const panel = e.api.getPanel(data.panelId)
  if (panel) panel.api.moveTo({ group: newGroup, position: 'center' })
}

export function WorkspaceDock(): JSX.Element {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  const apiRef = useRef<DockviewApi | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [apiReady, setApiReady] = useState(false)
  const isReconcilingRef = useRef(false)
  // activeTabId 闭包会过期（事件订阅 effect 只挂一次），用 ref 保最新值供 remove 回调用
  const activeTabIdRef = useRef<string | null>(activeTabId)
  activeTabIdRef.current = activeTabId

  // 滑动玻璃底板：对齐原 TabBar active-plate（每个 group 的 tabs 容器各一块）
  // 只在 api 就绪时挂载；后续 tab 增删/切换由 MutationObserver 跟
  useEffect(() => {
    const root = rootRef.current
    if (!root || !apiReady) return
    return mountDockActivePlates(root)
  }, [apiReady])

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

      // 残留 chat panel（tabs 已无）→ 关闭。crew pane（id 以 crew: 开头）由用户/dock 自管，不在此清。
      for (const orphanId of currentIds) {
        if (orphanId.startsWith('crew:')) continue
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
    // 注意：跨 group move 时原生可能先 remove 再 open；若 panel 仍在 api 里，
    // 说明是搬迁不是关闭，切勿 closeTab（否则会把会话从 tabs 里删掉再被 reconcile 搞乱）。
    const dRemove = api.onDidRemovePanel((panel: IDockviewPanel) => {
      if (isReconcilingRef.current) return
      if (panel.id.startsWith('crew:')) return
      // 仍挂在 dock 上 = 跨组分屏搬迁，不是关 tab
      if (api.getPanel(panel.id)) return
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

    // Dockview 激活 panel → 软同步 activeTabIdAtom（侧栏高亮等用）。
    // 仅 chat pane（id=sessionId）同步；crew pane（id=crew:xxx）激活不改 activeTabId，
    // 否则 App 的 activeTab 查 tabs 找不到 → 误判无活跃 tab → 显示引导页盖住整个 dock。
    const dActive = api.onDidActivePanelChange((evt) => {
      if (isReconcilingRef.current) return
      const panel = (evt as { panel?: IDockviewPanel }).panel
      if (!panel || panel.id.startsWith('crew:')) return
      setActiveTabId(panel.id)
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

    // 禁止 content 中心 drop 指示器；标签栏（含跨分屏 tab / header_space）指示器保留
    const dOverlay = api.onWillShowOverlay((evt) => {
      if (evt.kind === 'content' && evt.position === 'center') {
        evt.preventDefault()
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
      dOverlay.dispose()
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

  return (
    <div ref={rootRef} className="workspace-dock h-full min-h-0">
      <DockviewReact
        onReady={handleReady}
        components={{ chat: ChatPane, crew: CrewPane }}
        defaultTabComponent={DockTab}
        theme={dockTheme}
        onWillDrop={handleWillDrop}
        className="workspace-dock__canvas"
      />
    </div>
  )
}
