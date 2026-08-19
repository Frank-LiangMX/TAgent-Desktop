/**
 * 会话生命周期管理（双核：kscc 真长驻 / Pi 每轮重建 loop）
 *
 * 见 docs/plans/2026-07-25-longlived-event-loop-rewrite-design.md §3。
 *
 * **kscc 核**（真长驻）：
 * - 首次消息：spawn kscc + 起持续事件循环
 * - 后续消息：复用进程，enqueue 新消息；result 后 loop **不退**
 * - 会话关闭：destroy → 杀进程
 *
 * **Pi 核**（每 turn 后 loop 关闭，Agent 对象仍可在 adapter 内存）：
 * - 每轮 result 后 `loopRunning=false`、`state='closed'`，`hasLiveProcess()` 变 false
 * - 下一轮 sendMessage 走 isFirst 重建 SessionRuntime + 重走 `query()`（Pi 自管 state.messages）
 * - **不要**把 Pi 当成「进程级长驻」：steer/enqueue 的 live 路径对 Pi 基本不可用，
 *   由 session-service 降级为 pending_next_turn（本轮结束后自动发）
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
  /**
   * loop 真正停稳（Pi 每轮 generator done / 软停回 idle）后回调。
   * 用于 pending steer flush：不可在 onTurnEnd（仍在 for-await 内）立刻 handleSend，
   * 否则会把 turnInFlight 再置真，旧 loop 退出误判「进程异常退出」。
   */
  private onLoopIdle?: () => void
  private onError?: (err: Error) => void
  /**
   * startLoop 代数：新 loop 启动时递增。旧 runLoop 退出时若代数已变，
   * 不得再改 loopRunning/state，也不得走崩溃恢复。
   */
  private loopEpoch = 0

  /** 用户主动 destroy（关标签页 / 被顶 / 退出）→ 永久关闭，不恢复、不报错 */
  private userClosing = false
  /** 用户主动 stop（interrupt）→ 本轮退出不恢复、不报错；下一轮 sendMessage 清除 */
  private userStopping = false
  /**
   * 正在进行的软中断。renderer 会先把 UI 切到 stopped，再等待 STOP_AGENT IPC；
   * 用户若立刻发送下一条，必须先等这次中断完成，不能直接撞 `turnInFlight`。
   */
  private interruptInFlight: Promise<void> | undefined
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
  /**
   * 当前长驻进程绑定的执行形态指纹（chat|work|…）。
   * Chat↔Work 切换后工具集/systemPrompt 会变，必须 drop 进程再 spawn，不能只 enqueue。
   */
  private spawnToolingFingerprint: string | undefined

  constructor(sessionId: string, adapter: AgentProviderAdapter) {
    this.sessionId = sessionId
    this.adapter = adapter
  }

  /** 是否已有常驻进程（首条 vs 后续判断） */
  hasLiveProcess(): boolean {
    return this.loopRunning && this.adapter.hasActiveChannel?.(this.sessionId) === true
  }

  /** 从 queryOptions 提取工具/形态指纹（executionMode 优先，否则扫 kanban 注入痕迹） */
  private static toolingFingerprint(
    queryOptions: Parameters<AgentProviderAdapter['query']>[0],
  ): string {
    const o = queryOptions as {
      executionMode?: string
      mcpServers?: Record<string, unknown>
      extraTools?: Array<{ name?: string }>
      systemPrompt?: { append?: string } | string
      systemPromptAppend?: string
    }
    if (o.executionMode === 'chat' || o.executionMode === 'work') {
      return o.executionMode
    }
    const hasKanbanMcp = !!(o.mcpServers && 'kanban' in o.mcpServers)
    const hasKanbanExtra = (o.extraTools ?? []).some((t) =>
      String(t?.name ?? '').toLowerCase().includes('kanban'),
    )
    return hasKanbanMcp || hasKanbanExtra ? 'work' : 'chat'
  }

  /**
   * 丢弃 **仍在跑** 的长驻进程（主要是 kscc），供 executionMode 热切换。
   *
   * - kscc：loop 长驻 + MCP/systemPrompt 在 spawn 时锁定 → 必须 abort，下次 re-spawn + resume
   * - Pi：每 turn 后 loop 已退、Agent 仍在内存 → **不要 abort**（会丢 state.messages），
   *   靠 PiAdapter 在下次 query 时按 toolingKey 热重建并保留消息
   */
  dropLiveProcessForConfigChange(reason = 'config-change'): void {
    this.spawnToolingFingerprint = undefined
    // 仅当事件循环仍在跑时杀进程（kscc 热切换场景）
    if (!this.loopRunning || this.adapter.hasActiveChannel?.(this.sessionId) !== true) {
      console.log(
        `[会话 ${this.sessionId}] executionMode 配置变更（${reason}）：无长驻 loop，跳过 abort（Pi 将热重建工具）`,
      )
      return
    }
    console.log(`[会话 ${this.sessionId}] 丢弃长驻进程（${reason}），下次消息按新配置 spawn`)
    // 标记用户主动停止，避免 runLoop 把 abort 当成崩溃恢复
    this.userStopping = true
    try {
      this.adapter.abort(this.sessionId)
    } catch (err) {
      console.warn(`[会话 ${this.sessionId}] abort 长驻进程失败:`, err)
    }
    this.loopRunning = false
    this.turnInFlight = false
    // 保持 runtime 可复用：不要 userClosing
    this.state = 'idle'
    queueMicrotask(() => {
      if (!this.loopRunning) this.userStopping = false
    })
  }

  /** 注册流式回调 */
  setCallbacks(cb: {
    onMessage?: (msg: SDKMessage) => void
    onTurnEnd?: () => void
    onLoopIdle?: () => void
    onError?: (err: Error) => void
  }): void {
    this.onMessage = cb.onMessage
    this.onTurnEnd = cb.onTurnEnd
    this.onLoopIdle = cb.onLoopIdle
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
    // UI 的停止态早于主进程 query.interrupt() 完成；快速发送时在此串行化，避免误报
    // 「上一轮仍在跑」。
    const pendingInterrupt = this.interruptInFlight
    if (pendingInterrupt) await pendingInterrupt

    if (this.state === 'closed') {
      throw new Error(`[session ${this.sessionId}] 会话已关闭`)
    }

    // 新一轮用户消息：清除上一轮的主动停止标记（本轮重新参与崩溃恢复判定）
    this.userStopping = false

    const nextFp = SessionRuntime.toolingFingerprint(queryOptions)

    // Chat↔Work 等导致工具集变化：丢弃旧进程，用新 queryOptions re-spawn（kscc 靠 resume 续历史）
    if (
      this.hasLiveProcess() &&
      this.spawnToolingFingerprint &&
      this.spawnToolingFingerprint !== nextFp
    ) {
      if (this.turnInFlight) {
        throw new Error(
          `[session ${this.sessionId}] 上一轮仍在跑，请结束后再切换执行形态后发送`,
        )
      }
      console.log(
        `[会话 ${this.sessionId}] 执行形态/工具集变更 ${this.spawnToolingFingerprint} → ${nextFp}，re-spawn`,
      )
      this.dropLiveProcessForConfigChange('executionMode-or-tools')
      // 把本轮用户文本并入新 spawn 的 prompt
      let prompt = queryOptions.prompt
      if (userMessage) {
        const c = userMessage.message?.content
        if (typeof c === 'string' && c.trim()) prompt = c
        else if (Array.isArray(c)) {
          const text = c
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim()
          if (text) prompt = text
        }
      }
      this.lastInFlightPrompt = prompt
      this.spawnToolingFingerprint = nextFp
      await this.startLoop({ ...queryOptions, prompt })
      return
    }

    // 首次：spawn + 起持续循环
    if (!this.hasLiveProcess()) {
      // 记录在飞消息（崩溃恢复时重注入；result 后清空）
      this.lastInFlightPrompt = queryOptions.prompt
      this.spawnToolingFingerprint = nextFp
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
    {
      const c = userMessage.message.content
      this.lastInFlightPrompt =
        typeof c === 'string'
          ? c
          : c
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
    }
    this.turnInFlight = true
    await this.adapter.sendQueuedMessage?.(this.sessionId, userMessage)
  }

  /** 起持续事件循环（首次 / 恢复重建） */
  private async startLoop(
    queryOptions: Parameters<AgentProviderAdapter['query']>[0]
  ): Promise<void> {
    this.loopEpoch += 1
    const epoch = this.loopEpoch
    this.loopRunning = true
    this.turnInFlight = true
    this.state = 'running'

    // 异步跑循环，不阻塞 sendMessage
    void this.runLoop(queryOptions, epoch)
  }

  /**
   * 事件循环：遍历 adapter.query 流。
   *
   * - **kscc**：result 后 for-await 不结束，等 channel 下条 enqueue（真长驻）
   * - **Pi**：每 turn prompt 结束后 generator done → for-await 退出 → state=closed
   *   （Agent 仍可在 PiAdapter.sessions 里；下一轮 re-query 复用 entry）
   *
   * 外层 while 仅在「可恢复的崩溃」时再转一圈（re-spawn + resume）。
   */
  private async runLoop(
    initialQueryOptions: Parameters<AgentProviderAdapter['query']>[0],
    epoch: number,
  ): Promise<void> {
    let queryOptions = initialQueryOptions

    // 外层：崩溃恢复 re-spawn（最多 MAX_AUTO_RECOVERY 次）；正常路径只跑一圈
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let crashed = false
      /** 本圈 for-await 内是否已收到成功 result（过长除外） */
      let sawCleanResult = false
      try {
        if (epoch !== this.loopEpoch) return
        this.loopRunning = true
        const iterable = this.adapter.query(queryOptions)
        for await (const msg of iterable) {
          if (epoch !== this.loopEpoch) return
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
            // 每轮 result：清 turnInFlight + onTurnEnd（→ IPC turn_end）
            // kscc：for-await 不因 result 结束，继续等下条 enqueue
            // Pi：generator 在 prompt 结束后 done，下面 for-await 退出 → onLoopIdle（再 flush steer）
            // 单真源终态（No-Progress Guard §20.5）：首轮终态才 onTurnEnd，重复终态只标记 sawCleanResult，
            // 不再次 onTurnEnd（适配器已把 paused_no_progress 等归一为唯一终态）。
            const wasInFlight = this.turnInFlight
            this.turnInFlight = false
            this.lastInFlightPrompt = undefined
            sawCleanResult = true
            if (wasInFlight) this.onTurnEnd?.()
          }
        }
        // 已被更新的 startLoop 接替：旧圈不得改共享状态 / 不得报崩溃
        if (epoch !== this.loopEpoch) return
        // 循环退出 = 进程退出（iterResult.done）/ abort / Pi 每 turn 正常收尾
        this.loopRunning = false
        // 用户主动关闭 → 永久 closed
        if (this.userClosing) {
          this.state = 'closed'
          return
        }
        // 软停止 / 配置切换 abort：回 idle，runtime 可 re-spawn（勿 closed，否则 sendMessage 直接抛错）
        if (this.userStopping) {
          this.userStopping = false
          this.state = 'idle'
          this.onLoopIdle?.()
          return
        }
        // 本圈已干净 result：即使 onTurnEnd 竞态把 turnInFlight 再置真，也绝不当崩溃。
        // Pi 常态：turnInFlight 仍为 false → closed + onLoopIdle（pending steer 在此 flush）。
        if (sawCleanResult) {
          if (!this.turnInFlight) this.state = 'closed'
          this.onLoopIdle?.()
          return
        }
        // 进程在 turn 进行中退出（无 result 收尾）→ 视为崩溃，尝试恢复
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
          // turn 已正常结束后的退出（无显式 result 标记的干净路径）→ 关闭，下一轮重建
          this.state = 'closed'
          this.onLoopIdle?.()
          return
        }
      } catch (err) {
        if (epoch !== this.loopEpoch) return
        // query generator 抛错
        this.loopRunning = false
        if (this.userClosing) {
          this.state = 'closed'
          return
        }
        if (this.userStopping) {
          this.userStopping = false
          this.state = 'idle'
          this.onLoopIdle?.()
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
        if (sawCleanResult) {
          // result 后尾声抛错：不当崩溃；与干净退出一致
          if (!this.turnInFlight) this.state = 'closed'
          this.onLoopIdle?.()
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
        if (epoch !== this.loopEpoch) return
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

  /**
   * 软中断当前 turn。
   *
   * - 置 `userStopping`：本轮异常退出不触发自动恢复
   * - 清 `turnInFlight`：主进程侧栏 getSessionStatus 立刻 idle
   * - **不**调 `onTurnEnd`：UI 的 turn_end / running 清理由 session-service STOP_AGENT
   *   显式推（及渲染层 `userStopRun` 硬停）负责，避免与后续 result→onTurnEnd 双写混乱。
   * - kscc：SDK interrupt 保进程；Pi：agent.abort 软停，Agent 实例可保留在 adapter Map
   */
  async interrupt(): Promise<void> {
    if (this.interruptInFlight) {
      await this.interruptInFlight
      return
    }
    this.userStopping = true
    const operation = Promise.resolve()
      .then(() => this.adapter.interruptQuery?.(this.sessionId))
      .then(() => undefined)
      .finally(() => {
        this.turnInFlight = false
        if (this.interruptInFlight === operation) this.interruptInFlight = undefined
      })
    this.interruptInFlight = operation
    await operation
  }

  /**
   * 引导：仅在 **loop 仍存活** 时向 adapter 注入（kscc 长驻 enqueue 主路径）。
   *
   * - 有 live process → `sendQueuedMessage`，返回 `'live'`
   * - 无 live process（Pi 每轮 result 后常态）→ 返回 `'noop'`，**不静默假装成功**；
   *   调用方（session-service STEER_AGENT）须降级为 pending_next_turn
   */
  async steerMessage(message: string): Promise<'live' | 'noop'> {
    if (!this.hasLiveProcess()) return 'noop'
    if (!this.adapter.sendQueuedMessage) return 'noop'
    // 必须是完整 SDKUserMessage：缺 type/session_id 时 SDK 会丢弃，引导永远不生效。
    const steerInput: SDKUserMessageInput = {
      type: 'user',
      session_id: this.sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: message },
    }
    await this.adapter.sendQueuedMessage(this.sessionId, steerInput)
    return 'live'
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
    this.interruptInFlight = undefined
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
