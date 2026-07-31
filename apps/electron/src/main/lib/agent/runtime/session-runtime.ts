/**
 * 会话生命周期管理（长驻模式核心）
 *
 * 2026-07-25 长驻改造：会话 = 进程，常驻直到退出。
 * 见 docs/plans/2026-07-25-longlived-event-loop-rewrite-design.md §3。
 *
 * 一个会话一个 SessionRuntime，绑一个 kscc 进程。
 * - 首次消息：spawn kscc（带 resume，读一次历史）+ 起持续事件循环
 * - 后续消息：复用进程，enqueue 新消息
 * - 会话关闭：destroy → 杀进程
 *
 * 2026-07-29 Round 4 会话可靠性：
 * - 崩溃恢复：子进程异常退出 / channel 断连（非用户主动 stop）→ 自动 re-spawn + resumeSessionId
 *   重试当前消息一次；再失败上报 session_error。见 {@link runLoop} 与 {@link attemptRecovery}。
 * - 过长上下文：识别 SDK / stderr / result 中的 prompt too long → 推中文 session_error，不恢复。
 *   识别纯函数见 @tagent/shared utils/session-error-classify。
 * 见 docs/decisions/ADR-0002-longlived-process.md「已知缺口」。
 */
import type { AgentProviderAdapter, SDKMessage, SDKUserMessageInput } from '@tagent/shared'
import {
  formatPromptTooLongError,
  isPromptTooLongMessage,
  isPromptTooLongResult,
} from '@tagent/shared'

export type SessionState = 'idle' | 'running' | 'closed'

/** 自动崩溃恢复次数上限（避免无限重试；再失败即上报 session_error） */
const MAX_AUTO_RECOVERY = 1

/** stderr 累积上限（防无限增长；过长上下文错误文案通常在前几百字符即可命中） */
const STDERR_BUFFER_CAP = 4096

export class SessionRuntime {
  readonly sessionId: string
  private readonly adapter: AgentProviderAdapter
  private state: SessionState = 'idle'
  /** 当前轮是否在跑 */
  private turnInFlight = false
  /** 事件循环是否在跑（长驻：起进程后一直跑，直到 destroy） */
  private loopRunning = false
  /** 流式事件回调（orchestrator 注册，推 IPC 给 UI） */
  private onMessage?: (msg: SDKMessage) => void
  private onTurnEnd?: () => void
  private onError?: (err: Error) => void

  /** 用户主动 destroy（关标签页 / 被顶 / 退出）→ 永久关闭，不恢复、不报错 */
  private userClosing = false
  /** 用户主动 stop（interrupt）→ 本轮退出不恢复、不报错；下一轮 sendMessage 清除 */
  private userStopping = false
  /** 已执行的自动恢复次数（≤ MAX_AUTO_RECOVERY） */
  private recoveryAttempts = 0
  /** 从流式消息捕获的最新 SDK session id（恢复时作为 resumeSessionId） */
  private lastSdkSessionId: string | undefined
  /** 当前在飞的用户消息文本（崩溃恢复时重注入），result 后清空 */
  private lastInFlightPrompt: string | undefined
  /** 上一次非过长类异常（恢复仍失败时上报用） */
  private lastError: Error | undefined
  /** 累积的 kscc 子进程 stderr（喂给过长上下文识别） */
  private stderrBuffer = ''

  constructor(sessionId: string, adapter: AgentProviderAdapter) {
    this.sessionId = sessionId
    this.adapter = adapter
  }

  /** 是否已有常驻进程（首条 vs 后续判断） */
  hasLiveProcess(): boolean {
    return this.loopRunning && this.adapter.hasActiveChannel?.(this.sessionId) === true
  }

  /** 注册流式回调 */
  setCallbacks(cb: {
    onMessage?: (msg: SDKMessage) => void
    onTurnEnd?: () => void
    onError?: (err: Error) => void
  }): void {
    this.onMessage = cb.onMessage
    this.onTurnEnd = cb.onTurnEnd
    this.onError = cb.onError
  }

  /** 喂入子进程 stderr，供过长上下文等错误识别（session-service 的 onStderr 调用） */
  reportStderr(data: string): void {
    if (!data) return
    // 简单截断：保留末尾 STDERR_BUFFER_CAP 字符（错误通常在末尾）
    const next = this.stderrBuffer + data
    this.stderrBuffer =
      next.length > STDERR_BUFFER_CAP ? next.slice(next.length - STDERR_BUFFER_CAP) : next
  }

  /**
   * 发消息。首次 spawn + 起循环；后续 enqueue 复用。
   * @param queryOptions 传给 adapter.query 的选项（首次才有用）
   * @param userMessage 用户消息文本（后续 enqueue 用，首次已在 queryOptions.prompt）
   */
  async sendMessage(
    queryOptions: Parameters<AgentProviderAdapter['query']>[0],
    userMessage?: SDKUserMessageInput
  ): Promise<void> {
    if (this.state === 'closed') {
      throw new Error(`[session ${this.sessionId}] 会话已关闭`)
    }

    // 新一轮用户消息：清除上一轮的主动停止标记（本轮重新参与崩溃恢复判定）
    this.userStopping = false

    // 首次：spawn + 起持续循环
    if (!this.hasLiveProcess()) {
      // 记录在飞消息（崩溃恢复时重注入；result 后清空）
      this.lastInFlightPrompt = queryOptions.prompt
      await this.startLoop(queryOptions)
      return
    }

    // 后续：复用进程，enqueue
    if (this.turnInFlight) {
      throw new Error(`[session ${this.sessionId}] 上一轮仍在跑`)
    }
    if (!userMessage) {
      throw new Error(`[session ${this.sessionId}] 后续消息需提供 userMessage`)
    }
    this.lastInFlightPrompt = userMessage.message.content
    this.turnInFlight = true
    await this.adapter.sendQueuedMessage?.(this.sessionId, userMessage)
  }

  /** 起持续事件循环（首次 / 恢复重建） */
  private async startLoop(
    queryOptions: Parameters<AgentProviderAdapter['query']>[0]
  ): Promise<void> {
    this.loopRunning = true
    this.turnInFlight = true
    this.state = 'running'

    // 异步跑循环，不阻塞 sendMessage
    void this.runLoop(queryOptions)
  }

  /**
   * 持续事件循环：遍历 adapter.query 流，result 后不退，等下条。
   *
   * 外层 while 仅在「可恢复的崩溃」时再转一圈（re-spawn + resume）；正常长驻路径
   * 一直在内层 for-await 里跑，不会回到外层。
   */
  private async runLoop(
    initialQueryOptions: Parameters<AgentProviderAdapter['query']>[0]
  ): Promise<void> {
    let queryOptions = initialQueryOptions

    // 外层：崩溃恢复 re-spawn（最多 MAX_AUTO_RECOVERY 次）；正常路径只跑一圈
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let crashed = false
      try {
        this.loopRunning = true
        const iterable = this.adapter.query(queryOptions)
        for await (const msg of iterable) {
          // pi adapter 实际产 TAgentDesktopStreamPayload（{kind:...}），kscc 产 SDKMessage（{type:...}）。
          // 两者经同一 AsyncIterable<SDKMessage> 契约；此处按形状归一化 result 判定。
          const m = msg as { type?: string; kind?: string; errors?: unknown }
          const isResult = m.type === 'result' || m.kind === 'result'

          // 捕获 SDK session id（恢复时作为 resumeSessionId）；pi 无 session_id（自管），undefined 无害
          const sid = (msg as { session_id?: unknown }).session_id
          if (typeof sid === 'string' && sid) this.lastSdkSessionId = sid

          // 工具循环打点：assistant 含 tool_use 时记一下（验证工具循环跑通）
          if (msg.type === 'assistant') {
            const content = (msg as { message?: { content?: Array<{ type: string; name?: string }> } }).message?.content
            const toolUses = Array.isArray(content) ? content.filter((b) => b.type === 'tool_use') : []
            if (toolUses.length > 0) {
              console.log(`[会话 ${this.sessionId}] 工具调用: ${toolUses.map((t) => t.name).join(', ')}`)
            }
          }

          // 推给 orchestrator（→ IPC → UI）
          this.onMessage?.(msg)

          if (isResult) {
            // 过长上下文：result.errors 命中 → 推中文错误，结束本轮，不恢复。
            // kscc：isPromptTooLongResult 读 .type==='result'+.errors；
            // pi：result 是 {kind:'result', errors:[...]}，直接用 isPromptTooLongMessage 判 .errors。
            const tooLong =
              m.type === 'result'
                ? isPromptTooLongResult(msg)
                : isPromptTooLongMessage(...(Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === 'string') : []))
            if (tooLong) {
              this.turnInFlight = false
              this.lastInFlightPrompt = undefined
              this.loopRunning = false
              // Phase 4：先尝试软重置爆了兜底，失败再 closed + 报错
              void this.trySoftResetOnBurst().then((recovered) => {
                if (recovered) {
                  this.state = 'closed' // 进程需重建；下次 send 会 re-spawn
                  this.onTurnEnd?.()
                  this.onMessage?.({
                    type: 'system',
                    subtype: 'tagent_soft_reset',
                    content: '上下文过长，已整理记忆，请重试发送',
                  } as unknown as SDKMessage)
                } else {
                  this.state = 'closed'
                  this.onError?.(new Error(formatPromptTooLongError()))
                }
              })
              return
            }
            // 每轮 result：标记轮结束，发 turnEnd 信号（UI 知道这轮完）
            // 循环不退，等下条 enqueue 触发新轮
            this.turnInFlight = false
            this.lastInFlightPrompt = undefined
            this.onTurnEnd?.()
          }
        }
        // 循环退出 = 进程退出（iterResult.done）/ abort
        this.loopRunning = false
        // 用户主动关闭 / 停止 → 干净收尾，不恢复、不报错
        if (this.userClosing || this.userStopping) {
          this.userStopping = false
          this.state = 'closed'
          return
        }
        // 进程在 turn 进行中退出（无 result 收尾）→ 视为崩溃，尝试恢复
        // 注意：Pi 核每个 turn 正常 result 后 generator 也会退出，此时 turnInFlight=false，
        // 走 else 干净关闭（下一轮 sendMessage 自然 re-spawn），不会被误判为崩溃。
        if (this.turnInFlight) {
          // stderr 已命中过长上下文 → 降级提示，不当崩溃恢复
          if (isPromptTooLongMessage(this.stderrBuffer)) {
            this.turnInFlight = false
            this.lastInFlightPrompt = undefined
            void this.trySoftResetOnBurst().then((recovered) => {
              this.state = 'closed'
              if (!recovered) this.onError?.(new Error(formatPromptTooLongError()))
              else this.onTurnEnd?.()
            })
            return
          }
          crashed = true
        } else {
          // turn 已正常结束后的退出（Pi 每 turn / kscc 干净退出）→ 关闭，下一轮重建
          this.state = 'closed'
          return
        }
      } catch (err) {
        // query generator 抛错
        this.loopRunning = false
        if (this.userClosing || this.userStopping) {
          this.userStopping = false
          this.state = 'closed'
          return
        }
        const error = err instanceof Error ? err : new Error(String(err))
        // 过长上下文（抛错 message / stderr 命中）→ 中文提示，不恢复
        if (isPromptTooLongMessage(error.message, this.stderrBuffer)) {
          this.turnInFlight = false
          this.lastInFlightPrompt = undefined
          void this.trySoftResetOnBurst().then((recovered) => {
            this.state = 'closed'
            if (!recovered) this.onError?.(new Error(formatPromptTooLongError()))
            else this.onTurnEnd?.()
          })
          return
        }
        if (this.turnInFlight) {
          // turn 进行中抛错 → 视为崩溃，尝试恢复；记录错误以便恢复失败时上报
          crashed = true
          this.lastError = error
        } else {
          // turn 外抛错（罕见）→ 直接上报
          this.state = 'closed'
          this.onError?.(error)
          return
        }
      }

      if (crashed) {
        const recovery = this.attemptRecovery(queryOptions)
        if (recovery) {
          queryOptions = recovery
          // 继续外层循环：re-spawn + resume + 重注入在飞消息
          continue
        }
        // 不可恢复（无 resumeId / 无在飞消息 / 已用尽次数 / 用户停止）→ 上报 session_error
        this.state = 'closed'
        this.onError?.(
          this.lastError ?? new Error(`[session ${this.sessionId}] 会话进程异常退出，自动恢复失败`),
        )
        return
      }
    }
  }

  /**
   * 计算崩溃恢复的 re-spawn 选项。返回新的 queryOptions 表示可恢复，undefined 表示放弃。
   *
   * 策略（MVP，后续可加重试退避 / fork 重放等）：
   * - 仅当非用户停止、未超过 MAX_AUTO_RECOVERY、且有 resumeSessionId + 在飞消息时恢复
   * - 恢复 = 复用原 queryOptions 配置（canUseTool / mcpServers / systemPrompt 等），
   *   仅覆盖 resumeSessionId + prompt（重注入在飞消息）
   * - 重注入在飞消息可能造成「重复用户气泡」（SDK transcript 是否已落盘该消息不确定）；
   *   权衡：丢消息比重复气泡更糟，故选择重注入。后续可结合 resumeSessionAt / fork 精确去重。
   */
  /**
   * Phase 4：prompt_too_long 时尝试 kscc 软重置兜底（廉价清理 + 影子压缩切换）。
   * 动态 import 避免 runtime ↔ soft-reset 循环依赖启动成本。
   */
  private async trySoftResetOnBurst(): Promise<boolean> {
    try {
      const { ksccSoftReset } = await import('../kscc-soft-reset')
      return await ksccSoftReset.onBurst({
        sessionId: this.sessionId,
        burstTokens: undefined,
      })
    } catch (e) {
      console.warn(`[会话 ${this.sessionId}] soft-reset onBurst failed:`, e)
      return false
    }
  }

  private attemptRecovery(
    queryOptions: Parameters<AgentProviderAdapter['query']>[0]
  ): Parameters<AgentProviderAdapter['query']>[0] | undefined {
    if (this.userClosing || this.userStopping) return undefined
    if (this.recoveryAttempts >= MAX_AUTO_RECOVERY) return undefined
    const resumeId = this.lastSdkSessionId ?? (queryOptions as { resumeSessionId?: string }).resumeSessionId
    if (!resumeId || !this.lastInFlightPrompt) return undefined

    this.recoveryAttempts++
    this.lastError = undefined
    this.state = 'running'
    this.loopRunning = true
    this.turnInFlight = true
    // 清空 stderr：恢复后的新进程从空开始累积
    this.stderrBuffer = ''
    console.warn(
      `[会话 ${this.sessionId}] 进程异常退出，自动恢复 #${this.recoveryAttempts}（resume=${resumeId}）`,
    )
    return {
      ...queryOptions,
      resumeSessionId: resumeId,
      prompt: this.lastInFlightPrompt,
    } as Parameters<AgentProviderAdapter['query']>[0]
  }

  /** 软中断当前 turn（保进程） */
  async interrupt(): Promise<void> {
    // 用户主动 stop：本轮若异常退出不触发自动恢复
    this.userStopping = true
    await this.adapter.interruptQuery?.(this.sessionId)
    this.turnInFlight = false
  }

  /** 引导 Agent：不中断当前轮，在下一轮边界注入用户消息（Pi steer / kscc enqueue） */
  async steerMessage(message: string): Promise<void> {
    if (!this.hasLiveProcess()) return
    const steerInput = {
      message: { role: 'user' as const, content: message },
    }
    await this.adapter.sendQueuedMessage?.(this.sessionId, steerInput as any)
  }

  /** 热切换活跃会话的权限模式（kscc 走 SDK setPermissionMode；Pi 靠 beforeToolCall 闭包读 meta，无需重建） */
  async setPermissionMode(mode: string): Promise<void> {
    if (!this.adapter.setPermissionMode) return
    await this.adapter.setPermissionMode(this.sessionId, mode)
  }

  /** 热切换活跃会话模型（当前由 kscc SDK 原生支持） */
  async setModel(model: string): Promise<void> {
    if (!this.adapter.setModel) {
      throw new Error(`[session ${this.sessionId}] 当前运行内核不支持热切模型`)
    }
    await this.adapter.setModel(this.sessionId, model)
  }

  /** 销毁会话：杀进程（标签页关/被顶、关 TAgent） */
  destroy(): void {
    // 用户主动关闭：永久关闭，不触发自动恢复、不报错
    this.userClosing = true
    this.adapter.abort(this.sessionId)
    this.loopRunning = false
    this.turnInFlight = false
    this.state = 'closed'
  }

  isRunning(): boolean {
    return this.loopRunning
  }

  isTurnInFlight(): boolean {
    return this.turnInFlight
  }
}
