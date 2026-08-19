/**
 * 全局会话运行态同步 —— 对齐 TAgent_General 的 agentStreamingStatesAtom 思路
 *
 * 问题：Chat 用 key=sessionId 切换会卸载，onStreamEvent 只服务当前实例；
 * 离开会话后 result/delta 无人消费 → atom 与主进程脱节；切回时 remount reconcile
 * 又可能按 getSessionStatus 误清 startedAt，计时 pill 消失。
 *
 * 本 hook 在 App 根挂载一次，按 sessionId 维护 sessionRunMapAtom：
 * - 流式活动 → adopt（已有 startedAt 不重置，同 General transitionRunTimerState）
 * - result / session_error → stop
 * 与 Chat 内 startRun/completeRun 幂等；切会话后计时连续。
 *
 * CL2 新增：idle / 断流看门狗
 * - 追踪每个会话最近流式事件时间（lastStreamEventAt）
 * - 定时轮询：atom 仍 running + 超过 N 秒无流式事件 + 主进程 idle → stopSessionRun 兜底
 * - 纯函数 shouldForceIdle 可单测；看门狗不替代 result / session_error 正常路径
 * - 工具循环 / 子代理等待：tool_start、task_* 也刷新 lastStreamEventAt，避免误杀
 */
import { useEffect } from 'react'
import { getDefaultStore, useSetAtom } from 'jotai'
import {
  adoptSessionRunAtom,
  sessionRunMapAtom,
  stopSessionRunAtom,
} from '../atoms/session-run-atoms'
import {
  IDLE_WATCHDOG_TIMEOUT_MS,
  shouldForceIdle,
} from '@tagent/shared'
import {
  makeStatusTickerItem,
  pushStatusTickerAtom,
} from '../atoms/status-ticker'
import { getNotificationPrefsSnapshot } from '../atoms/notification-prefs'
import { isSessionAwaitingUser } from '../lib/session-awaiting-user'

type StreamEnvelope = {
  sessionId?: string
  payload?: {
    kind: string
    event?: { type?: string }
    subtype?: string
    errors?: unknown[]
    message?: {
      type?: string
      stop_reason?: string
      _partial?: boolean
      parentToolUseId?: string
    }
  }
}

/** 终态 assistant：不应再 adopt / 刷新 lastStreamEventAt（否则软停后被拉回 live） */
function isTerminalAssistantPayload(p: NonNullable<StreamEnvelope['payload']>): boolean {
  return (
    p.kind === 'sdk_message' &&
    p.message?.type === 'assistant' &&
    Boolean(p.message.stop_reason) &&
    p.message._partial !== true
  )
}

/** 子代理 parented 消息：不 adopt（失败后否则底栏运行态常驻） */
function isParentedSdkPayload(p: NonNullable<StreamEnvelope['payload']>): boolean {
  return (
    p.kind === 'sdk_message' &&
    (p.message?.type === 'assistant' || p.message?.type === 'user') &&
    Boolean(p.message?.parentToolUseId)
  )
}

/** 看门狗轮询间隔（ms）：每 5s 检查一次，最坏延迟 = TIMEOUT + INTERVAL ≈ 25s */
const WATCHDOG_POLL_INTERVAL_MS = 5_000

/** per-session 最近流式事件时间戳（ms） */
const lastStreamEventAtMap = new Map<string, number>()
/** 同一 run 的 result 可能被多个订阅路径观察到；每轮只提示一次。 */
const notifiedCompletionSessionIds = new Set<string>()

/** 流式活动 kind 集合（与 adopt 判定一致） */
const STREAM_ACTIVITY_KINDS = new Set([
  'stream_text_delta',
  'stream_thinking_delta',
  'sdk_message',
])

/** 工具循环 / 子代理仍在干活：刷新看门狗，必要时把软停拉回 running（不重置 startedAt） */
const KEEP_ALIVE_TAGENT_TYPES = new Set([
  'tool_start',
  'task_started',
  'task_progress',
  'task_notification',
  'moa_roundtable',
  'moa_discussion',
])

function isKeepAliveTagentPayload(p: NonNullable<StreamEnvelope['payload']>): boolean {
  return (
    p.kind === 'tagent_event' &&
    typeof p.event?.type === 'string' &&
    KEEP_ALIVE_TAGENT_TYPES.has(p.event.type)
  )
}

export function useGlobalSessionRunSync(): void {
  const adoptSessionRun = useSetAtom(adoptSessionRunAtom)
  const stopSessionRun = useSetAtom(stopSessionRunAtom)
  const pushTicker = useSetAtom(pushStatusTickerAtom)

  useEffect(() => {
    const off = window.electronAPI.onStreamEvent((raw: unknown) => {
      const env = raw as StreamEnvelope
      const sessionId = env?.sessionId
      const p = env?.payload
      if (!sessionId || !p?.kind) return

      if (p.kind === 'result') {
        const subtype = typeof p.subtype === 'string' ? p.subtype : ''
        // 等用户点选 / 无进展暂停：本轮没完，禁止硬清 startedAt，否则提交后从 0 重计
        if (subtype === 'paused_no_progress' || isSessionAwaitingUser(sessionId)) {
          lastStreamEventAtMap.set(sessionId, Date.now())
          return
        }
        lastStreamEventAtMap.delete(sessionId)
        stopSessionRun(sessionId)
        const isErrorResult =
          (typeof p.subtype === 'string' && p.subtype.startsWith('error_')) ||
          (Array.isArray(p.errors) && p.errors.length > 0)
        if (
          !isErrorResult &&
          !notifiedCompletionSessionIds.has(sessionId) &&
          getNotificationPrefsSnapshot().titlebarTicker
        ) {
          notifiedCompletionSessionIds.add(sessionId)
          // 完成事件只有 sessionId；异步补标题，避免把技术 id 暴露到顶栏。
          void window.electronAPI
            .listSessions()
            .then((sessions) => {
              const title = (sessions as Array<{ id?: string; title?: string }>)
                .find((session) => session.id === sessionId)
                ?.title?.trim()
              pushTicker(
                makeStatusTickerItem(
                  title ? `会话已完成 · ${title}` : '会话已完成',
                  'success',
                  6500,
                ),
              )
            })
            .catch(() => {
              pushTicker(makeStatusTickerItem('会话已完成', 'success', 6500))
            })
        }
        return
      }

      if (p.kind === 'tagent_event' && p.event?.type === 'session_error') {
        lastStreamEventAtMap.delete(sessionId)
        stopSessionRun(sessionId)
        return
      }

      // 流式活动：保证 running + 保住已有 startedAt（勿用 Date.now 重置）
      // 终态 assistant 跳过：无在途工具的 turn_end 已 schedule 软停，再 adopt 会把 UI 拉回「一直在跑」
      const isStreamActivity =
        STREAM_ACTIVITY_KINDS.has(p.kind) &&
        !isTerminalAssistantPayload(p) &&
        !isParentedSdkPayload(p)
      const isKeepAlive = isKeepAliveTagentPayload(p)
      if (isStreamActivity || isKeepAlive) {
        // 新一轮开始后允许该会话再次发布完成通知。
        notifiedCompletionSessionIds.delete(sessionId)
        lastStreamEventAtMap.set(sessionId, Date.now())
        const entry = getDefaultStore().get(sessionRunMapAtom)[sessionId]
        if (entry?.running && entry.startedAt != null) return
        // 子代理/工具 keep-alive：没有计时记忆就不要凭空开一轮（收口后迟到事件）
        if (isKeepAlive && entry?.startedAt == null) return
        adoptSessionRun({
          id: sessionId,
          startedAt: entry?.startedAt ?? Date.now(),
        })
      }
    })

    // CL2 idle 看门狗：定期检查超时 + 主进程 idle → 兜底 stopSessionRun
    // 含 soft-stop 孤儿：running=false 但 startedAt 残留（isLiveTurn 仍真）
    const watchdogTimer = window.setInterval(() => {
      const store = getDefaultStore()
      const runMap = store.get(sessionRunMapAtom)
      const now = Date.now()

      for (const [sessionId, entry] of Object.entries(runMap)) {
        const hasStartedAt = entry.startedAt != null
        if (!entry.running && !hasStartedAt) continue

        // 先做纯超时判定（无需 IPC）：未超时不浪费 getSessionStatus 调用
        const lastAt = lastStreamEventAtMap.get(sessionId) ?? null
        if (lastAt != null && now - lastAt < IDLE_WATCHDOG_TIMEOUT_MS) {
          continue // 未超时，跳过
        }

        // 超时或无记录：查主进程状态
        void window.electronAPI
          .getSessionStatus(sessionId)
          .then((status) => {
            const latest = store.get(sessionRunMapAtom)[sessionId]
            const forceIdle = shouldForceIdle({
              lastStreamEventAt: lastStreamEventAtMap.get(sessionId) ?? null,
              now: Date.now(),
              isMainProcessIdle: status?.status === 'idle',
              isAtomRunning: latest?.running ?? false,
              hasStartedAt: latest?.startedAt != null,
              awaitingUser: isSessionAwaitingUser(sessionId),
            })
            if (forceIdle) {
              lastStreamEventAtMap.delete(sessionId)
              stopSessionRun(sessionId)
            }
          })
          .catch(() => {
            // IPC 失败：保留现状，下一轮再试
          })
      }
    }, WATCHDOG_POLL_INTERVAL_MS)

    return () => {
      off?.()
      window.clearInterval(watchdogTimer)
    }
  }, [adoptSessionRun, stopSessionRun, pushTicker])
}
