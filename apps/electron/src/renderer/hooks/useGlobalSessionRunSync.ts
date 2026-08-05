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
 */
import { useEffect } from 'react'
import { getDefaultStore, useSetAtom } from 'jotai'
import {
  adoptSessionRunAtom,
  sessionRunMapAtom,
  stopSessionRunAtom,
} from '../atoms/session-run-atoms'

type StreamEnvelope = {
  sessionId?: string
  payload?: {
    kind: string
    event?: { type?: string }
  }
}

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
        stopSessionRun(sessionId)
        return
      }

      if (p.kind === 'tagent_event' && p.event?.type === 'session_error') {
        stopSessionRun(sessionId)
        return
      }

      // 流式活动：保证 running + 保住已有 startedAt（勿用 Date.now 重置）
      if (
        p.kind === 'stream_text_delta' ||
        p.kind === 'stream_thinking_delta' ||
        p.kind === 'sdk_message'
      ) {
        const entry = getDefaultStore().get(sessionRunMapAtom)[sessionId]
        if (entry?.running && entry.startedAt != null) return
        adoptSessionRun({
          id: sessionId,
          startedAt: entry?.startedAt ?? Date.now(),
        })
      }
    })
    return () => {
      off?.()
    }
  }, [adoptSessionRun, stopSessionRun])
}
