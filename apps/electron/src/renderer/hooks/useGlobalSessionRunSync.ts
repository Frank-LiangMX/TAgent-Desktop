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
 * - 纯函数 shouldForceIdle 可单测；看门狗不替代 turn_end / result / session_error 正常路径
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

type StreamEnvelope = {
  sessionId?: string
  payload?: {
    kind: string
    event?: { type?: string }
    message?: {
      type?: string
      stop_reason?: string
      _partial?: boolean
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

/** 看门狗轮询间隔（ms）：每 5s 检查一次，最坏延迟 = TIMEOUT + INTERVAL ≈ 25s */
const WATCHDOG_POLL_INTERVAL_MS = 5_000

/** per-session 最近流式事件时间戳（ms） */
const lastStreamEventAtMap = new Map<string, number>()

/** 流式活动 kind 集合（与 adopt 判定一致） */
const STREAM_ACTIVITY_KINDS = new Set([
  'stream_text_delta',
  'stream_thinking_delta',
  'sdk_message',
])

export function useGlobalSessionRunSync(): void {
  const adoptSessionRun = useSetAtom(adoptSessionRunAtom)
  const stopSessionRun = useSetAtom(stopSessionRunAtom)

  useEffect(() => {
    const off = window.electronAPI.onStreamEvent((raw: unknown) => {
      const env = raw as StreamEnvelope
      const sessionId = env?.sessionId
      const p = env?.payload
      if (!sessionId || !p?.kind) return

      if (p.kind === 'result') {
        lastStreamEventAtMap.delete(sessionId)
        stopSessionRun(sessionId)
        return
      }

      if (p.kind === 'tagent_event' && p.event?.type === 'session_error') {
        lastStreamEventAtMap.delete(sessionId)
        stopSessionRun(sessionId)
        return
      }

      // 流式活动：保证 running + 保住已有 startedAt（勿用 Date.now 重置）
      // 终态 assistant 跳过：turn_end 已 schedule 软/硬停，再 adopt 会把 UI 拉回「一直在跑」
      if (STREAM_ACTIVITY_KINDS.has(p.kind) && !isTerminalAssistantPayload(p)) {
        lastStreamEventAtMap.set(sessionId, Date.now())
        const entry = getDefaultStore().get(sessionRunMapAtom)[sessionId]
        if (entry?.running && entry.startedAt != null) return
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
  }, [adoptSessionRun, stopSessionRun])
}
