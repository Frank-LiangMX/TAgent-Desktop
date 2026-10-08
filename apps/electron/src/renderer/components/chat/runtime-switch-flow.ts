/**
 * 手动切换运行内核的**流程骨架**（渲染层）。
 *
 * 抽成纯函数是为了让「忙时拒绝 / 同步上锁 / 在途禁用 / 会话身份过期保护 /
 * 成功采纳 / 失败回滚」六条路径可被单测覆盖，而不必挂载整个 Chat。
 * Chat 只负责把本地 state 的读写接进来。
 *
 * 约定（对齐主进程 SWITCH_SESSION_RUNTIME 契约）：
 * - 会话运行中（running / startedAt 残留）→ 不发请求，要求用户先停止本轮
 * - 草稿会话（尚未持久化）→ 不调持久化 API，只做本地一致选择，首条发送时物化
 * - **同步**取锁：连续点击不会产生第二个切换 promise（不能用 useState 做闸门）
 * - 完成时校验**会话身份 + 请求代次**：切走会话后迟到的成功/失败不得改本地状态
 * - 失败**不**改动任何本地选择（无乐观写入）；调用方在失败时恢复捕获的旧值
 */
import type { AgentRuntimeKind, AgentSessionMeta, SessionRuntimeSwitchInput } from '@tagent/shared'

/** 会话运行中时的统一文案（选择器禁用 + 兜底提示共用）。 */
export const RUNTIME_SWITCH_BUSY_MESSAGE = '请先停止当前回合，再切换主 Agent'

/** 切换在途时的统一文案（并发点击 / 切换期间的发送都走它）。 */
export const RUNTIME_SWITCH_PENDING_MESSAGE = '正在切换主 Agent，请稍候'

/**
 * 交接资料口径：主进程只注入**最近一段可见对话的节选**（有字符预算），
 * 不是完整会话迁移。UI 文案必须如实描述，不得宣称无缝迁移。
 */
export const RUNTIME_HANDOFF_DESCRIPTION = '会带上最近可见对话的节选（不是完整迁移）'

/**
 * 已物化会话的 native home 与渠道/模型绑定是一体的。
 * 因此即使目标仍属于同一 Agent runtime，只要绑定对发生变化，也必须
 * 经过 switchSessionRuntime；只有草稿可以先用本地选择，首发时再物化。
 */
export function requiresBindingSwitch(
  isDraft: boolean,
  currentSelection: { channelId: string; modelId: string } | null | undefined,
  nextSelection: { channelId: string; modelId: string },
): boolean {
  if (isDraft) return false
  return (
    !currentSelection ||
    currentSelection.channelId !== nextSelection.channelId ||
    currentSelection.modelId !== nextSelection.modelId
  )
}

export interface RuntimeSwitchRequest {
  sessionId: string
  channelId: string
  modelId: string
  runtime: AgentRuntimeKind
}

export interface RuntimeSwitchOutcome {
  ok: boolean
  /** 成功时主进程回传的会话 meta（草稿会话为本地合成值） */
  meta?: AgentSessionMeta
  error?: string
  /** 因会话忙被拒绝（未发出请求） */
  blockedByBusy?: boolean
  /** 因已有切换在途被拒绝（未发出第二个请求） */
  blockedByPending?: boolean
  /** 本次完成已过期（切换期间换了会话 / 被更晚的切换取代）：调用方不得改状态 */
  stale?: boolean
}

/**
 * 同步切换闸门。
 *
 * `useState` 的 pending 只影响重渲染，同一 tick 内的重复点击仍会走到 handler →
 * 可能起两个切换 promise。这里用 ref 语义的同步锁 + 单调代次：
 * - `begin` 同步上锁并返回 token；已在途 → null（调用方直接 return）
 * - `accepts` 判断某个 token 的完成是否仍属于当前会话与最新代次
 * - `invalidate` 在切会话 / 销毁时调用，使所有在途完成立即过期
 */
export interface RuntimeSwitchGuard {
  begin(sessionId: string): number | null
  accepts(token: number, sessionId: string): boolean
  finish(token: number): void
  invalidate(): void
  readonly locked: boolean
}

export function createRuntimeSwitchGuard(): RuntimeSwitchGuard {
  let token = 0
  let locked = false
  let lockedSession: string | null = null
  return {
    begin(sessionId: string): number | null {
      if (locked) return null
      locked = true
      lockedSession = sessionId
      token += 1
      return token
    },
    accepts(candidate: number, sessionId: string): boolean {
      return locked && candidate === token && lockedSession === sessionId
    },
    finish(candidate: number): void {
      if (candidate !== token) return
      locked = false
      lockedSession = null
    },
    invalidate(): void {
      // 代次自增 → 所有在途 token 立即过期；锁同时释放，新会话可立刻再切
      token += 1
      locked = false
      lockedSession = null
    },
    get locked(): boolean {
      return locked
    },
  }
}

export interface RunRuntimeSwitchOptions {
  request: RuntimeSwitchRequest
  /** 会话是否正在运行（running 或 startedAt 未清） */
  busy: boolean
  /** 草稿会话：无持久化 meta，只做本地一致选择 */
  isDraft: boolean
  /** 同步闸门（同一 Chat 实例共享一个） */
  guard: RuntimeSwitchGuard
  /** 持久化切换通道（草稿会话下不会被调用） */
  switchRuntime: (input: SessionRuntimeSwitchInput) => Promise<AgentSessionMeta>
  /** 在途开关（true → 调用方禁用发送与并发切换） */
  onPendingChange: (pending: boolean) => void
  /** 成功采纳：主进程 meta（草稿为本地合成）+ 请求 */
  onAdopt: (meta: AgentSessionMeta, request: RuntimeSwitchRequest) => void
  /** 失败回滚：调用方恢复捕获的旧选择 / 旧内核状态 */
  onRollback: (error: Error, request: RuntimeSwitchRequest) => void
}

/**
 * 草稿会话的本地合成 meta：只在渲染层用于「采纳」路径，
 * 不写盘。首条消息发送时主进程按 channelId/modelId 建成正式 meta。
 */
function draftMetaFor(request: RuntimeSwitchRequest): AgentSessionMeta {
  return {
    id: request.sessionId,
    title: '',
    channelId: request.channelId,
    modelId: request.modelId,
    internalBackend: undefined,
    createdAt: 0,
    updatedAt: 0,
  }
}

export async function runRuntimeSwitch(
  options: RunRuntimeSwitchOptions,
): Promise<RuntimeSwitchOutcome> {
  const { request, busy, isDraft, guard, switchRuntime, onPendingChange, onAdopt, onRollback } =
    options

  if (busy) {
    return { ok: false, error: RUNTIME_SWITCH_BUSY_MESSAGE, blockedByBusy: true }
  }

  // 同步取锁：连续点击的第二个调用在这里直接返回，不会起第二个 promise
  const token = guard.begin(request.sessionId)
  if (token === null) {
    return { ok: false, error: RUNTIME_SWITCH_PENDING_MESSAGE, blockedByPending: true }
  }

  // 草稿会话：本地一致选择，首条发送时物化。不调持久化 API。
  if (isDraft) {
    const meta = draftMetaFor(request)
    guard.finish(token)
    onAdopt(meta, request)
    return { ok: true, meta }
  }

  onPendingChange(true)
  try {
    const meta = await switchRuntime({
      sessionId: request.sessionId,
      channelId: request.channelId,
      modelId: request.modelId,
      runtime: request.runtime,
    })
    // 会话身份 / 代次校验：切走会话后迟到的成功不得写本地状态
    if (!guard.accepts(token, request.sessionId)) {
      return { ok: false, stale: true, error: '会话已切换，忽略过期的内核切换结果' }
    }
    if (
      !meta || meta.id !== request.sessionId ||
      meta.channelId !== request.channelId || meta.modelId !== request.modelId
    ) {
      throw new Error('切换返回的会话绑定不完整或不匹配，请刷新会话后重试')
    }
    onAdopt(meta, request)
    return { ok: true, meta }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    if (!guard.accepts(token, request.sessionId)) {
      return { ok: false, stale: true, error: err.message }
    }
    onRollback(err, request)
    return { ok: false, error: err.message }
  } finally {
    const stillCurrent = guard.accepts(token, request.sessionId)
    guard.finish(token)
    // 切会话时由调用方复位；旧请求不能解除新会话正在进行的切换。
    if (stillCurrent) onPendingChange(false)
  }
}
