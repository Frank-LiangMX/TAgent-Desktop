/**
 * kscc resume 核软重置（Phase 4）
 *
 * D4 双 session A/B · D9 降级方案（新 query + 上下文回填）· D10 粗估触发。
 * 状态机：idle → compacting → ready → switching → switched → idle
 *
 * 与 kscc-soft-reset.sim.test.ts 骨架对齐；真实读写走 session-store。
 */
import { existsSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { AgentSessionMeta, SDKMessage } from '@tagent/shared'
import {
  appendSdkMessages,
  getSessionMeta,
  readSdkMessages,
  updateSessionMeta,
  writeSdkMessages,
} from './session-store'
import { getProjectSessionPath, getAgentSessionMessagesPath } from '../config/config-paths'
import { planDropOldToolResults, type SDKMessageRow } from '../memory/agent-session-compactor'
import { memoryEvidenceSink } from '../memory/memory-evidence-sink'
import { resolveModelSafeContextLimit } from '../channel/model-window'
import { getChannel } from '../channel/channel-store'
import { getLearnedSafeContextLimit, recordBurstAndLearn } from '../memory/context-limits-store'
import { CHARS_PER_TOKEN } from '../memory/agent-context-utils'
import {
  buildCompactionSplitUserPrompt,
  COMPACTION_SPLIT_SYSTEM,
  parseCompactionSplitResult,
} from '../memory/compaction-prompt'

const CHEAP_RATIO = 0.45
const SHADOW_RATIO = 0.6
const SWITCH_RATIO = 0.75

export type ShadowState = NonNullable<AgentSessionMeta['shadowState']>

export interface SoftResetTurnInput {
  sessionId: string
  /** result.usage.inputTokens（不准时可能为空） */
  inputTokens?: number
  modelId?: string
  channelId?: string
}

export interface SoftResetHooks {
  /** 切换时中止 A 进程 */
  abortSession?: (sessionId: string) => void
  /** 通知 UI：正在整理记忆 */
  onStatus?: (sessionId: string, status: 'compacting' | 'switching' | 'idle' | 'ready') => void
}

function estimateSdkTokens(messages: unknown[]): number {
  let chars = 0
  for (const raw of messages) {
    const m = raw as { message?: { content?: unknown } }
    const content = m.message?.content
    if (typeof content === 'string') {
      chars += content.length
      continue
    }
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      const block = b as { text?: string; content?: unknown; type?: string }
      if (typeof block.text === 'string') chars += block.text.length
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const c of block.content as Array<{ text?: string }>) {
          if (c?.text) chars += c.text.length
        }
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function lastMessageUuid(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = (messages[i] as { uuid?: string })?.uuid
    if (u) return u
  }
  return undefined
}

function resolveSdkPath(workspaceId: string | undefined, sessionId: string): string {
  return workspaceId
    ? getProjectSessionPath(workspaceId, sessionId)
    : getAgentSessionMessagesPath(sessionId)
}

function collectDialogText(messages: unknown[]): string {
  const texts: string[] = []
  for (const raw of messages.slice(0, 80)) {
    const m = raw as { type?: string; message?: { content?: unknown } }
    if (m.type !== 'user' && m.type !== 'assistant') continue
    const content = m.message?.content
    if (typeof content === 'string') texts.push(content.slice(0, 400))
    else if (Array.isArray(content)) {
      for (const b of content as Array<{ type?: string; text?: string }>) {
        if (b?.type === 'text' && b.text) texts.push(b.text.slice(0, 400))
      }
    }
  }
  return texts.join('\n')
}

function toSummaryMsg(summary: string): SDKMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            '## session_recovery\n\n以下是此前会话的压缩摘要，请在此基础上继续：\n\n' + summary,
        },
      ],
    },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

/** 本地规则摘要（LLM 失败时保底） */
function localSummarize(messages: unknown[]): {
  summaryMsg: SDKMessage
  facts: string[]
  summary: string
} {
  const body = collectDialogText(messages)
  const summary =
    `[会话摘要] 共 ${messages.length} 条消息。要点：\n` +
    body
      .split('\n')
      .filter(Boolean)
      .slice(0, 12)
      .map((l) => `• ${l.slice(0, 200)}`)
      .join('\n')
  return { summaryMsg: toSummaryMsg(summary), facts: [], summary }
}

/** 优先 LLM 分流压缩，失败回退本地 */
async function summarizeMessages(messages: unknown[]): Promise<{
  summaryMsg: SDKMessage
  facts: string[]
  summary: string
}> {
  try {
    const { completeMemoryLlm } = await import('../memory/memory-llm-client')
    const dialog = collectDialogText(messages).slice(0, 60_000)
    if (dialog.length < 40) return localSummarize(messages)
    const raw = await completeMemoryLlm({
      systemPrompt: COMPACTION_SPLIT_SYSTEM,
      userPrompt: buildCompactionSplitUserPrompt(dialog),
    })
    const parsed = parseCompactionSplitResult(raw)
    return {
      summaryMsg: toSummaryMsg(parsed.summary),
      facts: parsed.facts,
      summary: parsed.summary,
    }
  } catch (e) {
    console.warn('[kscc-soft-reset] LLM summarize failed, local fallback:', e)
    return localSummarize(messages)
  }
}

class KsccSoftResetService {
  private hooks: SoftResetHooks = {}
  private compacting = new Set<string>()

  setHooks(hooks: SoftResetHooks): void {
    this.hooks = hooks
  }

  /** 每轮 result 后调用：廉价清理 / 拉影子 / 切换 */
  async onTurnResult(input: SoftResetTurnInput): Promise<void> {
    const meta = getSessionMeta(input.sessionId)
    if (!meta) return
    if (meta.shadowState === 'switching') return

    const workspaceId = meta.workspaceId
    const sdkMsgs = readSdkMessages(workspaceId, input.sessionId)
    const estimated = input.inputTokens && input.inputTokens > 0
      ? input.inputTokens
      : estimateSdkTokens(sdkMsgs)

    const channel = input.channelId ? getChannel(input.channelId) : undefined
    const modelId = input.modelId ?? meta.modelId
    const learned = modelId
      ? getLearnedSafeContextLimit(modelId, workspaceId)
      : undefined
    const safeLimit = resolveModelSafeContextLimit(channel, modelId, learned)

    // 1) 廉价清理
    if (estimated >= safeLimit * CHEAP_RATIO) {
      this.maybeCheapClean(workspaceId, input.sessionId, sdkMsgs)
    }

    // 2) 拉影子
    const state = meta.shadowState ?? 'idle'
    if (estimated >= safeLimit * SHADOW_RATIO && (state === 'idle' || state === 'switched')) {
      void this.startShadowCompact(input.sessionId, meta)
    }

    // 3) 切换
    if (estimated >= safeLimit * SWITCH_RATIO && meta.shadowState === 'ready') {
      await this.atomicSwitch(input.sessionId)
    }
  }

  /** 爆了兜底：强制清理 + 必要时同步压 B 再切 */
  async onBurst(input: SoftResetTurnInput & { burstTokens?: number }): Promise<boolean> {
    const meta = getSessionMeta(input.sessionId)
    if (!meta) return false
    const workspaceId = meta.workspaceId
    const sdkMsgs = readSdkMessages(workspaceId, input.sessionId)

    // 自学习
    const modelId = input.modelId ?? meta.modelId ?? 'unknown'
    const channel = input.channelId ? getChannel(input.channelId) : undefined
    const window =
      channel?.models.find((m) => m.id === modelId)?.contextWindow ?? 200_000
    const burst = input.burstTokens ?? estimateSdkTokens(sdkMsgs)
    try {
      const learned = recordBurstAndLearn({
        modelId,
        burstTokens: burst,
        contextWindow: window,
        workspaceSlug: workspaceId,
      })
      updateSessionMeta(input.sessionId, {
        lastBurstTokenCount: burst,
        learnedSafeContextLimit: learned,
      })
    } catch (e) {
      console.warn('[kscc-soft-reset] recordBurst failed:', e)
    }

    this.maybeCheapClean(workspaceId, input.sessionId, sdkMsgs, true)

    // 若无 ready 影子，同步起一个
    const refreshed = getSessionMeta(input.sessionId)
    if (refreshed?.shadowState !== 'ready') {
      await this.startShadowCompact(input.sessionId, refreshed ?? meta, true)
    }
    const after = getSessionMeta(input.sessionId)
    if (after?.shadowState === 'ready' || after?.shadowSessionId) {
      return this.atomicSwitch(input.sessionId)
    }
    return false
  }

  private maybeCheapClean(
    workspaceId: string | undefined,
    sessionId: string,
    sdkMsgs: unknown[],
    _force = false,
  ): void {
    try {
      const plan = planDropOldToolResults(sdkMsgs as SDKMessageRow[])
      if (!plan.dropped.length || plan.kept.length >= sdkMsgs.length) return
      writeSdkMessages(workspaceId, sessionId, plan.kept)
      console.log(
        `[kscc-soft-reset] cheap clean session=${sessionId.slice(0, 8)} ${sdkMsgs.length}→${plan.kept.length}`,
      )
    } catch (e) {
      console.warn('[kscc-soft-reset] cheap clean failed:', e)
    }
  }

  private async startShadowCompact(
    sessionId: string,
    meta: AgentSessionMeta,
    sync = false,
  ): Promise<void> {
    if (this.compacting.has(sessionId)) return
    this.compacting.add(sessionId)
    const workspaceId = meta.workspaceId
    const shadowSessionId = `shadow-${randomUUID()}`
    const sdkMsgs = readSdkMessages(workspaceId, sessionId)
    const cursor = lastMessageUuid(sdkMsgs)

    updateSessionMeta(sessionId, {
      shadowState: 'compacting',
      shadowSessionId,
      shadowCursor: cursor,
    })
    this.hooks.onStatus?.(sessionId, 'compacting')

    const run = async (): Promise<void> => {
      try {
        const { summaryMsg, facts, summary } = await summarizeMessages(sdkMsgs)
        writeSdkMessages(workspaceId, shadowSessionId, [summaryMsg])
        // 事实进 evidence sink
        for (const fact of facts.slice(0, 10)) {
          try {
            memoryEvidenceSink.writeSessionEvidence(
              meta.mode === 'ta' ? 'ta' : 'general',
              sessionId,
              'soft-reset-fact',
              fact,
              [],
            )
          } catch {
            /* ignore */
          }
        }
        void summary
        updateSessionMeta(sessionId, {
          shadowState: 'ready',
          shadowSessionId,
          shadowCursor: cursor,
        })
        this.hooks.onStatus?.(sessionId, 'ready')
        console.log(
          `[kscc-soft-reset] shadow ready session=${sessionId.slice(0, 8)} shadow=${shadowSessionId.slice(0, 12)}`,
        )
      } catch (e) {
        console.error('[kscc-soft-reset] shadow compact failed:', e)
        updateSessionMeta(sessionId, { shadowState: 'idle', shadowSessionId: undefined })
        this.hooks.onStatus?.(sessionId, 'idle')
      } finally {
        this.compacting.delete(sessionId)
      }
    }

    if (sync) await run()
    else void run()
  }

  /**
   * 原子切换（D9）：补尾 → 归档 A → meta 改指 B 文件作 resume 源
   * Desktop 降级：不预 spawn B，把 B 的 JSONL 作为下次 resume 的内容源，
   * 通过清空 sdkSessionId + 写 recovery 到 B，下次 spawn 新 query。
   */
  async atomicSwitch(sessionId: string): Promise<boolean> {
    const meta = getSessionMeta(sessionId)
    if (!meta?.shadowSessionId) return false
    const workspaceId = meta.workspaceId
    const shadowId = meta.shadowSessionId
    const cursor = meta.shadowCursor

    updateSessionMeta(sessionId, { shadowState: 'switching' })
    this.hooks.onStatus?.(sessionId, 'switching')

    try {
      // 中止 A
      this.hooks.abortSession?.(sessionId)

      // 补尾：cursor 之后的 A 消息追加到 B
      const aMsgs = readSdkMessages(workspaceId, sessionId)
      let tail: unknown[] = []
      if (cursor) {
        const idx = aMsgs.findIndex((m) => (m as { uuid?: string }).uuid === cursor)
        if (idx >= 0) tail = aMsgs.slice(idx + 1)
        else tail = aMsgs.slice(-6)
      } else {
        tail = aMsgs.slice(-6)
      }
      if (tail.length > 0) {
        appendSdkMessages(workspaceId, shadowId, tail)
      }

      // 归档 A 的 SDK JSONL
      const aPath = resolveSdkPath(workspaceId, sessionId)
      if (existsSync(aPath)) {
        try {
          renameSync(aPath, `${aPath}.archived`)
        } catch (e) {
          console.warn('[kscc-soft-reset] archive A failed:', e)
        }
      }

      // 将 B 的内容复制为新的主 SDK JSONL（sessionId 文件名），清空 sdkSessionId 强制新 query
      const bMsgs = readSdkMessages(workspaceId, shadowId)
      writeSdkMessages(workspaceId, sessionId, bMsgs)

      const prevSdk = meta.sdkSessionId
      updateSessionMeta(sessionId, {
        sdkSessionId: undefined, // 下次 spawn 新 query + 读新 JSONL 上下文（D9）
        resumeAtMessageUuid: undefined,
        shadowState: 'idle',
        shadowSessionId: undefined,
        shadowCursor: undefined,
        shadowChainPrev: prevSdk ?? shadowId,
      })
      this.hooks.onStatus?.(sessionId, 'idle')
      console.log(`[kscc-soft-reset] switched session=${sessionId.slice(0, 8)} prevSdk=${prevSdk ?? '-'}`)
      return true
    } catch (e) {
      console.error('[kscc-soft-reset] atomicSwitch failed, rollback:', e)
      updateSessionMeta(sessionId, { shadowState: 'ready' })
      this.hooks.onStatus?.(sessionId, 'ready')
      return false
    }
  }

  /** 供调试/测试：当前状态 */
  getState(sessionId: string): AgentSessionMeta['shadowState'] | undefined {
    return getSessionMeta(sessionId)?.shadowState
  }
}

export const ksccSoftReset = new KsccSoftResetService()

// re-export prompt helpers for future LLM path
export { buildCompactionSplitUserPrompt, COMPACTION_SPLIT_SYSTEM, parseCompactionSplitResult }
