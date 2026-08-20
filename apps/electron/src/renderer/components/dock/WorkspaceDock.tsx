/**
 * WorkspaceDock — Dockview 分屏工作台宿主（实验，splitDockModeAtom 开启时渲染）。
 *
 * 数据流：
 * - tabsAtom 是「哪些会话打开」的真相源；Dockview 管 layout（分屏方向/group 树）。
 * - tabsAtom → api：缺 panel 则 addPanel；dock 多出的 chat → 回填 tabs（不关 panel）。
 * - 关 panel：Dockview × → onDidRemovePanel；TabBar/侧栏删除 → closeTab + api.close。
 * - 拖 tab 分屏只动 layout；误删 tabs 时由 reconcile 回填修复。
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
import { FilePreviewPane } from './FilePreviewPane'
import { RichPreviewPane } from './RichPreviewPane'
import { BrowserPane } from './BrowserPane'
import { DockTab } from './DockTab'
import { DockSummaryActions } from './DockSummaryActions'
import { SessionSummaryTabButton } from '../chat/SessionSummaryTabButton'
import { MAX_SESSION_TABS, tabsAtom, activeTabIdAtom, closeTab, type TabItem } from '../../atoms/tabs'
import {
  dockApiAtom,
  visibleSessionsAtom,
  collectVisibleSessions,
  crewOpenRequestAtom,
  crewPanelOpenMapAtom,
  splitSessionsRequestAtom,
} from '../../atoms/dock-api'
import { filePreviewRequestAtom } from '../../atoms/file-preview'
import { richPreviewRequestAtom } from '../../atoms/rich-preview'
import { browserApi, browserOpenRequestAtom } from '../../atoms/browser'
import { sessionRunMapAtom } from '../../atoms/session-run-atoms'
import { disableVoidGroupDrag, isGroupHeaderDrag, pruneEmptyDockGroups } from './dock-dnd'

const DOCK_LAYOUT_KEY = 'tagent:dockLayout'

/**
 * 非会话 pane 的 id 前缀：crew（班组）、file-preview（文件预览）、mermaid-preview。
 * 这类 pane 激活/关闭都不得同步 tabsAtom/activeTabIdAtom——
 * 否则 App 的 activeTab 查 tabs 找不到 → 误判无活跃 tab → 显示引导页盖住整个 dock。
 */
const NON_SESSION_PANE_PREFIXES = ['crew:', 'file-preview:', 'mermaid-preview:', 'rich-preview:', 'browser:'] as const
function isNonSessionPane(id: string): boolean {
  return NON_SESSION_PANE_PREFIXES.some((prefix) => id.startsWith(prefix))
}

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
 * - 标签栏右侧空白整组拖（panelId 空）→ 禁止，避免拖出空标签
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

  // void / 整组拖：panelId 为 null，落下会留下空 group + "Multiple Panels (N)" 幽灵
  if (isGroupHeaderDrag(data)) {
    e.preventDefault()
    return
  }

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
  const sessionRunMap = useAtomValue(sessionRunMapAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setDockApi = useSetAtom(dockApiAtom)
  const setVisibleSessions = useSetAtom(visibleSessionsAtom)
  const crewOpenRequest = useAtomValue(crewOpenRequestAtom)
  const setCrewPanelOpenMap = useSetAtom(crewPanelOpenMapAtom)
  const filePreviewReq = useAtomValue(filePreviewRequestAtom)
  const setFilePreviewRequest = useSetAtom(filePreviewRequestAtom)
  const richPreviewReq = useAtomValue(richPreviewRequestAtom)
  const setRichPreviewRequest = useSetAtom(richPreviewRequestAtom)
  const browserOpenRequest = useAtomValue(browserOpenRequestAtom)
  const setBrowserOpenRequest = useSetAtom(browserOpenRequestAtom)
  const splitSessionsRequest = useAtomValue(splitSessionsRequestAtom)
  const setSplitSessionsRequest = useSetAtom(splitSessionsRequestAtom)

  const apiRef = useRef<DockviewApi | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [apiReady, setApiReady] = useState(false)
  const isReconcilingRef = useRef(false)
  // activeTabId 闭包会过期（事件订阅 effect 只挂一次），用 ref 保最新值供 remove 回调用
  const activeTabIdRef = useRef<string | null>(activeTabId)
  activeTabIdRef.current = activeTabId

  // 旧版曾在 Dockview tab 容器中注入滑动底板；group 增删时其测量坐标会残留，
  // 留下一条错误的底线。现在选中态由 tab 自身绘制；这里顺手清理热更新遗留节点。
  useEffect(() => {
    const root = rootRef.current
    if (!root || !apiReady) return
    root.querySelectorAll('[data-dock-active-plate]').forEach((plate) => plate.remove())
  }, [apiReady])

  // tabsAtom → api：补齐缺失 panel；dock 多出的 chat → 回填 tabs（不在此关 panel）。
  // 关 panel 由显式路径负责：Dockview × → onDidRemovePanel；TabBar × → closeTab + api.close。
  // 旧逻辑「tabs 无则关 orphan」会在拖分屏误删 tabs 时把第 3 块干掉或留下 tabs/panels 漂移。
  useEffect(() => {
    const api = apiRef.current
    if (!api || !apiReady) return
    isReconcilingRef.current = true
    try {
      const currentIds = new Set<string>()
      api.panels.forEach((p: IDockviewPanel) => currentIds.add(p.id))

      const toAdopt: TabItem[] = []

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

      for (const orphanId of currentIds) {
        if (isNonSessionPane(orphanId)) continue
        const orphan = api.getPanel(orphanId)
        toAdopt.push({
          id: orphanId,
          sessionId: orphanId,
          title: orphan?.title || '会话',
        })
      }

      if (toAdopt.length > 0) {
        const availableSlots = Math.max(0, MAX_SESSION_TABS - tabs.length)
        const accepted = toAdopt.slice(0, availableSlots)
        const rejected = toAdopt.slice(availableSlots)
        setTabs((prev: TabItem[]) => {
          const have = new Set(prev.map((t) => t.sessionId))
          const add = accepted.filter((t) => !have.has(t.sessionId))
          return add.length ? [...prev, ...add] : prev
        })
        // 限额以外的旧 pane 不允许反向回填；非运行会话直接关掉，运行中的保留，
        // 交给 App 的历史修复逻辑处理，避免后台任务被静默中止。
        rejected.forEach((tab) => {
          if (!sessionRunMap[tab.sessionId]?.running) api.getPanel(tab.sessionId)?.api.close()
        })
      }
      setVisibleSessions(collectVisibleSessions(api))
    } finally {
      queueMicrotask(() => {
        isReconcilingRef.current = false
      })
    }
  }, [tabs, sessionRunMap, apiReady, setTabs, setVisibleSessions])

  // activeTabIdAtom → api：侧栏/外部改激活 tab 时，Dockview 同步 setActive。
  // 原先只有 onDidActivePanelChange → atom（dock→侧栏），缺 atom→dock，
  // 导致侧栏点会话只改高亮、主区仍停在旧 panel。
  useEffect(() => {
    const api = apiRef.current
    if (!api || !apiReady || !activeTabId) return
    if (isNonSessionPane(activeTabId)) return
    const panel = api.getPanel(activeTabId)
    if (!panel) return
    // 已是激活 panel 则跳过，避免与 onDidActivePanelChange 来回刷
    if (panel.api.isActive) return
    isReconcilingRef.current = true
    try {
      panel.api.setActive?.()
    } finally {
      // 下一 macrotask 再放行：setActive 的 change 事件常同步/微任务派发
      queueMicrotask(() => {
        isReconcilingRef.current = false
      })
    }
  }, [activeTabId, apiReady, tabs])

  // 顶栏等全局入口请求：直接打开/聚焦绑定会话的班组 pane。
  useEffect(() => {
    const api = apiRef.current
    const request = crewOpenRequest
    if (!api || !apiReady || !request) return

    const open = (): void => {
      const crewId = `crew:${request.sessionId}`
      const existing = api.getPanel(crewId)
      if (existing) {
        if (request.toggle) {
          existing.api.close()
          setCrewPanelOpenMap((prev) => ({ ...prev, [request.sessionId]: false }))
          return
        }
        existing.api.setActive?.()
        setCrewPanelOpenMap((prev) => ({ ...prev, [request.sessionId]: true }))
        return
      }
      const chatPanel = api.getPanel(request.sessionId)
      api.addPanel({
        id: crewId,
        title: `班组 · ${request.sessionTitle ?? chatPanel?.title ?? '会话'}`,
        component: 'crew',
        params: { sessionId: request.sessionId, paneType: 'crew' },
        ...(chatPanel ? { position: { direction: 'right', referencePanel: chatPanel } } : {}),
      })
      setCrewPanelOpenMap((prev) => ({ ...prev, [request.sessionId]: true }))
    }

    // 先让 App 的 openSession 完成 tabs → Dockview 同步，再作为右侧 pane 打开。
    const frame = requestAnimationFrame(open)
    return () => cancelAnimationFrame(frame)
  }, [crewOpenRequest?.requestId, apiReady, setCrewPanelOpenMap])

  useEffect(() => {
    const off = browserApi().onBrowserOpenRequest((request) => setBrowserOpenRequest(request))
    return off
  }, [setBrowserOpenRequest])

  // 事件订阅：api 就绪时挂，卸载时清（onReady 回调返回值会被 Dockview 忽略，故用 effect）
  useEffect(() => {
    const api = apiRef.current
    if (!api || !apiReady) return
    // 用户在 Dockview 关 panel → 同步 tabsAtom（非我们 reconcile 触发的）
    // 注意：跨 group move 时原生可能先 remove 再挂回；若同步立刻 closeTab，
    // tabs 会丢会话，随后 panel 又出现 → 「分屏 3 块、tabs/打开中只有 2」漂移。
    // 延后到下一帧确认 panel 真的不在了再关。
    const dRemove = api.onDidRemovePanel((panel: IDockviewPanel) => {
      if (panel.id.startsWith('crew:')) {
        const sid = panel.id.slice('crew:'.length)
        setCrewPanelOpenMap((prev) => ({ ...prev, [sid]: false }))
      }
      // 用户主动关预览分屏（× / 拖走）→ 清掉对应请求 atom。否则切走 rail 再回来时
      // WorkspaceDock 重新挂载、apiReady 转 true 会触发预览 effect 重跑，凭残留 atom
      // 把已关的预览 pane 又建出来（切 rail 卸载重挂稳定复现）。
      if (panel.id.startsWith('file-preview:')) {
        const sid = panel.id.slice('file-preview:'.length)
        setFilePreviewRequest((prev) => (prev && prev.sessionId === sid ? null : prev))
      }
      if (panel.id.startsWith('rich-preview:')) {
        const sid = panel.id.slice('rich-preview:'.length)
        setRichPreviewRequest((prev) => (prev && prev.sessionId === sid ? null : prev))
      }
      if (panel.id.startsWith('browser:')) {
        const sid = panel.id.slice('browser:'.length)
        setBrowserOpenRequest((prev) => (prev && prev.sessionId === sid ? null : prev))
      }
      if (isReconcilingRef.current) return
      if (isNonSessionPane(panel.id)) return
      const sessionId = panel.id
      requestAnimationFrame(() => {
        if (isReconcilingRef.current) return
        if (api.getPanel(sessionId)) return
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
    })

    // Dockview 激活 panel → 软同步 activeTabIdAtom（侧栏高亮等用）。
    // 仅 chat pane（id=sessionId）同步；crew pane（id=crew:xxx）激活不改 activeTabId，
    // 否则 App 的 activeTab 查 tabs 找不到 → 误判无活跃 tab → 显示引导页盖住整个 dock。
    const dActive = api.onDidActivePanelChange((evt) => {
      if (isReconcilingRef.current) return
      const panel = (evt as { panel?: IDockviewPanel }).panel
      if (!panel || isNonSessionPane(panel.id)) {
        setVisibleSessions(collectVisibleSessions(api))
        return
      }
      setActiveTabId(panel.id)
      setVisibleSessions(collectVisibleSessions(api))
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
    // 同时：dock 里仍有、tabsAtom 没有的 chat panel → 补回 tabs（修搬迁误删漂移）。
    let rafId: number | null = null
    const persistAndRepairTabs = (): void => {
      if (rafId != null) return
      rafId = window.requestAnimationFrame(() => {
        rafId = null
        try {
          localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(api.toJSON()))
        } catch {
          /* 存储失败（配额/隐私模式）忽略 */
        }
        setVisibleSessions(collectVisibleSessions(api))
        if (rootRef.current) disableVoidGroupDrag(rootRef.current)
        if (isReconcilingRef.current) return
        const missing: TabItem[] = []
        api.panels.forEach((p: IDockviewPanel) => {
          if (isNonSessionPane(p.id)) return
          missing.push({
            id: p.id,
            sessionId: p.id,
            title: p.title || '会话',
          })
        })
        if (missing.length === 0) return
        setTabs((prev: TabItem[]) => {
          const have = new Set(prev.map((t) => t.sessionId))
          const toAdd = missing.filter((t) => !have.has(t.sessionId))
          return toAdd.length ? [...prev, ...toAdd] : prev
        })
      })
    }
    const dLayout = api.onDidLayoutChange(() => persistAndRepairTabs())

    // 挂载时修一次已有漂移（例如此前搬迁误删 tabs、panel 仍在）
    persistAndRepairTabs()
    if (rootRef.current) disableVoidGroupDrag(rootRef.current)
    pruneEmptyDockGroups(api)

    const dAddGroup = api.onDidAddGroup(() => {
      if (rootRef.current) disableVoidGroupDrag(rootRef.current)
    })

    const blockVoidGroupDrag = (event: DragEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest('.dv-void-container')) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    const dockRoot = rootRef.current
    dockRoot?.addEventListener('dragstart', blockVoidGroupDrag, true)

    return () => {
      dRemove.dispose()
      dActive.dispose()
      dUnhandled.dispose()
      dOverlay.dispose()
      dLayout.dispose()
      dAddGroup.dispose()
      dockRoot?.removeEventListener('dragstart', blockVoidGroupDrag, true)
      if (rafId != null) window.cancelAnimationFrame(rafId)
      // 卸载时最后存一次（关 flag / 切走）
      try {
        localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(api.toJSON()))
      } catch {
        /* 忽略 */
      }
    }
  }, [apiReady, setTabs, setActiveTabId, setVisibleSessions])

  // 文件预览请求 → 在 chat 面板右侧分屏开/聚焦预览 pane（同会话复用，内容由 atom 驱动刷新）
  useEffect(() => {
    const api = apiRef.current
    if (!api || !apiReady || !filePreviewReq) return
    const { sessionId, path, title, review } = filePreviewReq
    const paneId = `file-preview:${sessionId}`
    const fileName = title ?? path.split(/[\\/]/).pop() ?? path
    // 句尾 Files Changed 带 review → 审阅；正文 chip / 附件 → 预览
    const paneTitle = review ? `审阅 · ${fileName}` : `预览 · ${fileName}`
    const existing = api.getPanel(paneId)
    if (existing) {
      existing.setTitle?.(paneTitle)
      existing.api.setActive?.()
      return
    }
    const chatPanel = api.getPanel(sessionId)
    api.addPanel({
      id: paneId,
      title: paneTitle,
      component: 'file-preview',
      params: { sessionId, paneType: 'file-preview' },
      ...(chatPanel ? { position: { direction: 'right', referencePanel: chatPanel } } : {}),
    })
  }, [apiReady, filePreviewReq])

  // 富块（Mermaid / DataTable / JSON …）→ 独立标签分屏（同会话复用）
  useEffect(() => {
    const api = apiRef.current
    if (!api || !apiReady || !richPreviewReq) return
    const { sessionId, kind, title } = richPreviewReq
    const paneId = `rich-preview:${sessionId}`
    const label = title?.trim() || kind
    const existing = api.getPanel(paneId)
    if (existing) {
      existing.setTitle?.(`预览 · ${label}`)
      existing.api.setActive?.()
      return
    }
    const chatPanel = api.getPanel(sessionId)
    api.addPanel({
      id: paneId,
      title: `预览 · ${label}`,
      component: 'rich-preview',
      params: { sessionId, paneType: 'rich-preview' },
      ...(chatPanel ? { position: { direction: 'right', referencePanel: chatPanel } } : {}),
    })
  }, [apiReady, richPreviewReq])

  // Agent 请求打开网页 → 独立浏览器标签分屏（不写入 tabsAtom）
  useEffect(() => {
    const api = apiRef.current
    if (!api || !apiReady || !browserOpenRequest) return
    const request = browserOpenRequest
    const paneId = 'browser:' + request.sessionId
    const title = request.title?.trim() || '网页'
    const existing = api.getPanel(paneId)
    if (existing) {
      existing.setTitle?.(title)
      existing.api.setActive?.()
      setBrowserOpenRequest(null)
      return
    }
    const chatPanel = api.getPanel(request.sessionId)
    api.addPanel({
      id: paneId,
      title,
      component: 'browser',
      params: { sessionId: request.sessionId },
      ...(chatPanel ? { position: { direction: 'right', referencePanel: chatPanel } } : {}),
    })
    setBrowserOpenRequest(null)
  }, [apiReady, browserOpenRequest, setBrowserOpenRequest])

  // 分屏建议请求：非分屏模式下检测到频繁切换，用户点击「开启分屏」后，
  // 把两个会话左右并排展示。
  useEffect(() => {
    const api = apiRef.current
    if (!api || !apiReady || !splitSessionsRequest) return

    const frame = requestAnimationFrame(() => {
      const { leftSessionId, rightSessionId } = splitSessionsRequest
      const leftPanel = api.getPanel(leftSessionId)
      const rightPanel = api.getPanel(rightSessionId)
      if (!leftPanel || !rightPanel) {
        setSplitSessionsRequest(null)
        return
      }

      // 如果两个 panel 已在不同 group，只确保焦点在左
      if (leftPanel.api.group !== rightPanel.api.group) {
        leftPanel.api.setActive?.()
        setSplitSessionsRequest(null)
        return
      }

      // 在 leftPanel 的右侧新建 group，把 rightPanel 移过去
      const newGroup = api.addGroup({
        referenceGroup: leftPanel.api.group.id,
        direction: 'right',
      })
      rightPanel.api.moveTo({ group: newGroup, position: 'center' })
      leftPanel.api.setActive?.()
      setSplitSessionsRequest(null)
    })

    return () => cancelAnimationFrame(frame)
  }, [apiReady, splitSessionsRequest, setSplitSessionsRequest])

  const handleReady = (e: { api: DockviewApi }): void => {
    apiRef.current = e.api
    setDockApi(e.api)
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
    // layout 里已有、tabsAtom 尚未收录的 chat → 先补进 tabs
    const fromLayout: TabItem[] = []
    e.api.panels.forEach((p: IDockviewPanel) => {
      if (isNonSessionPane(p.id)) return
      fromLayout.push({
        id: p.id,
        sessionId: p.id,
        title: p.title || '会话',
      })
    })
    if (fromLayout.length > 0) {
      const availableSlots = Math.max(0, MAX_SESSION_TABS - tabs.length)
      const accepted = fromLayout.slice(0, availableSlots)
      const rejected = fromLayout.slice(availableSlots)
      setTabs((prev: TabItem[]) => {
        const have = new Set(prev.map((t) => t.sessionId))
        const toAdd = accepted.filter((t) => !have.has(t.sessionId))
        return toAdd.length ? [...prev, ...toAdd] : prev
      })
      rejected.forEach((tab) => {
        if (!sessionRunMap[tab.sessionId]?.running) e.api.getPanel(tab.sessionId)?.api.close()
      })
    }
    setVisibleSessions(collectVisibleSessions(e.api))
    if (rootRef.current) disableVoidGroupDrag(rootRef.current)
    pruneEmptyDockGroups(e.api)
    setApiReady(true)
  }

  useEffect(() => {
    return () => {
      setDockApi(null)
      setVisibleSessions([])
    }
  }, [setDockApi, setVisibleSessions])

  return (
    <div ref={rootRef} className="workspace-dock h-full min-h-0">
      <div className="workspace-dock__summary titlebar-no-drag">
        <SessionSummaryTabButton sessionId={activeTabId} />
      </div>
      <DockviewReact
        onReady={handleReady}
        components={{
          chat: ChatPane,
          crew: CrewPane,
          'file-preview': FilePreviewPane,
          'rich-preview': RichPreviewPane,
          browser: BrowserPane,
          // 兼容旧布局里残留的 mermaid-preview pane id
          'mermaid-preview': RichPreviewPane,
        }}
        defaultTabComponent={DockTab}
        rightHeaderActionsComponent={DockSummaryActions}
        disableFloatingGroups
        theme={dockTheme}
        onWillDrop={handleWillDrop}
        /**
         * 必须 always：默认的 onlyWhenVisible 会把非激活面板的 DOM 从文档里摘掉
         * （content.ts 的 element.remove()），浏览器随之丢掉布局盒，scrollTop 归零，
         * 切回来就落到底部。always 让面板常驻文档、仅用 visibility:hidden 隐藏，
         * 布局盒还在，滚动位置由浏览器天然保住。
         * React 树本来就一直挂着（dockview-react 不卸载），故此项不增加 JS 开销。
         */
        defaultRenderer="always"
        className="workspace-dock__canvas"
      />
    </div>
  )
}
