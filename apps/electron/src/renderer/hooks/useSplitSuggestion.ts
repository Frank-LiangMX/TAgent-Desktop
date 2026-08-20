/**
 * useSplitSuggestion — 检测用户频繁在两个会话间切换，建议开启分屏。
 *
 * 触发条件（仅 splitDockModeAtom === false 时生效）：
 * - 依据真实的会话激活切换（activeTabIdAtom 变化），不把重渲染算作切换
 * - 60 秒窗口内同两个 session 之间累计至少 4 次交替切换
 * - 同一对 session 触发后进入 5 分钟冷却，避免连续弹窗
 *
 * 用户点击「开启分屏」→ 开启 splitDockMode + 派发 splitSessionsRequestAtom，
 * 由 WorkspaceDock 把两个会话左右分屏展示。
 */
import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { activeTabIdAtom, tabsAtom } from '../atoms/tabs'
import { splitDockModeAtom, setSplitDockMode } from '../atoms/feature-flags'
import { splitSessionsRequestAtom } from '../atoms/dock-api'
import {
  findAlternatingPair,
  isInCooldown,
  setCooldown,
  SPLIT_SUGGESTION_CONFIG,
  type SwitchRecord,
} from '../atoms/split-suggestion'

/** toast 是否已弹出（防止重复弹） */
const showToastsInFlight = new Set<string>()

/** 切换历史（模块级，跟随组件生命周期由 effect 维护） */
let switchHistory: SwitchRecord[] = []
/** 冷却表 */
let cooldownMap = new Map<string, number>()

export function useSplitSuggestion(): void {
  const activeTabId = useAtomValue(activeTabIdAtom)
  const splitDockMode = useAtomValue(splitDockModeAtom)
  const tabs = useAtomValue(tabsAtom)
  const setSplitMode = useSetAtom(setSplitDockMode)
  const setSplitRequest = useSetAtom(splitSessionsRequestAtom)

  // 上一次的 activeTabId（用于判断真实切换，而非重渲染）
  const prevActiveRef = useRef<string | null>(activeTabId)

  // 切换事件记录（effect，依赖真实 activeTabId 变化）
  useEffect(() => {
    // 分屏已开启时不检测
    if (splitDockMode) {
      prevActiveRef.current = activeTabId
      switchHistory = []
      return
    }

    // 首次渲染不算切换
    if (prevActiveRef.current == null) {
      prevActiveRef.current = activeTabId
      return
    }

    const prev = prevActiveRef.current
    const curr = activeTabId

    // 记录当前值（先于判断，避免闭包问题）
    prevActiveRef.current = curr

    // 只有真正的切换（sessionId 变化）才算，且必须是有效的会话 tab
    if (!curr || curr === prev) return
    const currIsTab = tabs.some((t) => t.sessionId === curr)
    const prevIsTab = tabs.some((t) => t.sessionId === prev)
    if (!currIsTab || !prevIsTab) return

    const now = Date.now()

    // 第一次切换需要把切换前的会话作为起点，否则四次切换只有四条记录，
    // 检测器无法统计出四个 transition。
    const lastRecord = switchHistory.at(-1)
    if (!lastRecord || lastRecord.sessionId !== prev) {
      switchHistory.push({ sessionId: prev, timestamp: now })
    }

    // 加入切换历史（保证相邻记录 sessionId 不同）
    switchHistory.push({ sessionId: curr, timestamp: now })
    // 清理窗口外旧记录
    const cutoff = now - SPLIT_SUGGESTION_CONFIG.WINDOW_MS
    switchHistory = switchHistory.filter((r) => r.timestamp >= cutoff)

    // 检测交替切换 pair
    const pair = findAlternatingPair(switchHistory, now)

    if (!pair) return
    if (isInCooldown(cooldownMap, pair, now)) {
      // 冷却中：清掉历史，避免冷却结束后立刻重复计数
      switchHistory = []
      return
    }

    // 触发通知（同一对去重，防并发重复弹）
    const toastKey = pair.slice().sort().join('::')
    if (showToastsInFlight.has(toastKey)) return
    showToastsInFlight.add(toastKey)
    setCooldown(cooldownMap, pair, now)

    const titleOf = (id: string): string => tabs.find((t) => t.sessionId === id)?.title ?? '会话'
    const [left, right] = splitOrder(pair, prev)

    toast('检测到您常在两个会话间切换', {
      description: `“${titleOf(left)}”与“${titleOf(right)}”建议左右分屏同时查看`,
      duration: 6000,
      position: 'top-center',
      // className: 'split-suggestion-toast',
      action: {
        label: '开启分屏',
        onClick: () => {
          // 开启分屏并请求左右并排
          showToastsInFlight.delete(toastKey)
          setSplitMode(true)
          setSplitRequest({
            leftSessionId: left,
            rightSessionId: right,
            requestId: Date.now(),
          })
        },
      },
      onDismiss: () => {
        showToastsInFlight.delete(toastKey)
      },
      onAutoClose: () => {
        showToastsInFlight.delete(toastKey)
      },
    })
  }, [activeTabId, splitDockMode, tabs, setSplitMode, setSplitRequest])
}

/** 决定左右：优先让「当前活跃的会话」放左边 */
function splitOrder(
  pair: [string, string],
  activeSessionId: string | null,
): [string, string] {
  if (pair[0] === activeSessionId) return [pair[0], pair[1]]
  if (pair[1] === activeSessionId) return [pair[1], pair[0]]
  return pair
}
