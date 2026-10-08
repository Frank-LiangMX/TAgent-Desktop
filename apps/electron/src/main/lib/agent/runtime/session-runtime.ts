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

/**
 * 本轮终态性质（`onTurnEnd` 携带）。
 *
 * **不是所有 `onTurnEnd` 都是成功**：`result` 的 `error_max_turns` / `error_during_execution` /
 * `paused_no_progress` / `max_tokens`、以及上下文溢出软重置后的收尾都会走到 onTurnEnd。
 * 需要「成功才动作」的调用方（如跨内核交接消费）必须读本字段，不能把 onTurnEnd 当成功。
 */
export type TurnTerminalOutcome = 'success' | 'error' | 'unknown'

export interface TurnTerminalInfo {
  outcome: TurnTerminalOutcome
}

/**
 * 从终态消息判定本轮结局。明确成功的 result（通用 SDK 的 `subtype==='success'`，或 Codex
 * 形状的 `kind==='result' && subtype==='completed'`）且无 is_error / errors 才算 success；带
 * subtype 的其它值（error_max_turns / error_during_execution / paused_no_progress / max_tokens…）
 * 一律 error；形状无法判定 → unknown（调用方按「非成功」处理）。错误标志优先于 success/completed。
 */
export function classifyTurnTerminal(msg: unknown): TurnTerminalOutcome {
  if (!msg || typeof msg !== 'object') return 'unknown'
  const m = msg as {
    type?: string
    kind?: string
    subtype?: unknown
    is_error?: unknown
    isError?: unknown
    errors?: unknown
  }
  if (m.type !== 'result' && m.kind !== 'result') return 'unknown'
  const flagError = m.is_error === true || m.isError === true
  const hasErrors = Array.isArray(m.errors) && m.errors.length > 0
  if (typeof m.subtype === 'string') {
    if (!flagError && !hasErrors && (m.subtype === 'success' || (m.kind === 'result' && m.subtype === 'completed'))) {
      return 'success'
    }
    return 'error'
  }
  if (flagError || hasErrors) return 'error'
  return 'unknown'
}

/** 等待「停止受理后原生终态」的上限（毫秒）；超时即 fail-closed */
export const TURN_SETTLE_TIMEOUT_MS = 15_000

export interface SessionRuntimeOptions {
  /** 由具体后端注入的上下文溢出恢复能力。 */
  onContextOverflow?: () => Promise<boolean>
}

/** 自动崩溃恢复次数上限（避免无限重试；再失败即上报 session_error） */
const MAX_AUTO_RECOVERY = 1

/** stderr 累积上限（防无限增长；过长上下文错误文案通常在前几百字符即可命中） */
const STDERR_BUFFER_CAP = 4096

export class SessionRuntime {
  readonly sessionId: string
  private readonly adapter: AgentProviderAdapter
  private readonly onContextOverflow?: () => Promise<boolean>
  private state: SessionState = 'idle'
  /** 当前轮是否在跑 */
  private turnInFlight = false
  /** 事件循环是否在跑（长驻：起进程后一直跑，直到 destroy） */
  private loopRunning = false
  /** 流式事件回调（orchestrator 注册，推 IPC 给 UI） */
  private onMessage?: (msg: SDKMessage) => void
  /** 本轮终态回调（**非**成功专属；info.outcome 由 classifyTurnTerminal 判定） */
  private onTurnEnd?: (info?: TurnTerminalInfo) => void
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
  /**
   * 因配置/工具形态变更而被退役的长驻 loop。
   *
   * 与普通 STOP 不同，配置换核不能在收到 result 时就认为旧进程已静默：kscc/Codex
   * 仍可能保持 generator，直到 native session 真正关闭。该 fence 只允许该 loop 的
   * `runLoop` finally 解除，避免新 spawn 与旧进程尾声并行。
   */
  private retiringLoopEpoch: number | undefined

  /** 用户主动 destroy（关标签页 / 被顶 / 退出）→ 永久关闭，不恢复、不报错 */
  private userClosing = false
  /** 用户主动 stop（interrupt）→ 本轮退出不恢复、不报错；下一轮 sendMessage 清除 */
  private userStopping = false
  /**
   * 正在进行的软中断。renderer 会先把 UI 切到 stopped，再等待 STOP_AGENT IPC；
   * 用户若立刻发送下一条，必须先等这次中断完成，不能直接撞 `turnInFlight`。
   */
  private interruptInFlight: Promise<void> | undefined
  /**
   * 「已受理停止但尚未观察到本轮原生终态」闩锁（ADR-0011 §5 静默前提）。
   *
   * `interrupt()` 返回只表示**适配器受理了中断请求**（Claude SDK 控制请求受理 / Pi `agent.abort()`
   * 置标志 / Codex `turn/interrupt` 应答），**不**表示工具与子进程已停。跨内核切换若以此为静默
   * 依据，会出现旧内核工具在新内核开跑后继续写同一 workspace 的窗口。
   *
   * 因此：发起中断时置位，只有 runLoop 真正观察到本轮终态（result / generator 结束 / 抛错收尾）
   * 才复位；观察不到则保持置位，由 `waitForTurnSettled` 超时返回 false（调用方 fail-closed）。
   */
  private stopSettlementPending = false
  private settlementWaiters: Array<() => void> = []
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

  constructor(
    sessionId: string,
    adapter: AgentProviderAdapter,
    options: SessionRuntimeOptions = {},
  ) {
    this.sessionId = sessionId
    this.adapter = adapter
    this.onContextOverflow = options.onContextOverflow
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
    // 先立退役 fence，再调用 abort。abort 仅表示请求已受理；即使它同步吐出 result，
    // 也必须等旧 generator 的 finally 才能让下一个 query spawn。
    const retiringEpoch = this.loopEpoch
    this.retiringLoopEpoch = retiringEpoch
    this.stopSettlementPending = true
    // 标记用户主动停止，避免 runLoop 把 abort 当成崩溃恢复。不要在 microtask 清掉：
    // 旧 loop 仍可能在 drain，只有其退出路径才能安全复用 runtime。
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
  }

  /** 注册流式回调 */
  setCallbacks(cb: {
    onMessage?: (msg: SDKMessage) => void
    onTurnEnd?: (info?: TurnTerminalInfo) => void
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

    // 停止**受理**不等于旧回合已停稳：旧内核可能仍有工具在收尾。
    // 在旧回合收尾前开新回合会让两轮并行（同 workspace 写入竞态），故有界等待原生终态，
    // 超时则 fail-closed 拒绝本轮发送（不静默并行）。
    if (this.stopSettlementPending) await this.awaitStopSettlement()

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
      // 本次 SEND 自己触发了 retirement，入口处的闸门已经检查过，必须在这里
      // 再等一次；否则会直接 startLoop，与仍在 finally 中的旧 native loop 重叠。
      if (this.stopSettlementPending) await this.awaitStopSettlement()
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

  /** 有待结算停止时，统一有界等待；超时一律拒绝，绝不静默并行。 */
  private async awaitStopSettlement(): Promise<void> {
    if (!this.stopSettlementPending) return
    const settled = await this.waitForTurnSettled(TURN_SETTLE_TIMEOUT_MS)
    if (!settled) {
      throw new Error(
        `[session ${this.sessionId}] 上一轮尚未确认停稳（可能仍有工具在收尾），请稍候再发送`,
      )
    }
    // 等待期间用户可能已关闭会话。特别是配置换核分支会在此后直接 startLoop，
    // 因而必须在 settlement 后重新检查，不能让已销毁 runtime 复活。
    if (this.userClosing || this.state === 'closed') {
      throw new Error(`[session ${this.sessionId}] 会话已关闭`)
    }
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
    try {
      await this.runLoopInner(initialQueryOptions, epoch)
    } finally {
      // 任何退出路径（generator 结束 / 抛错 / 过长降级 return / 用户停止）都意味着
      // 本轮原生终态已被观察到 → 解除「已受理停止但未观察终态」闩锁。
      // 长驻内核（kscc）正常 result 后 loop 不退出，故 result 分支另有显式调用。
      // **带 epoch**：被 startLoop 接替的旧圈不得结算新回合的停止闩锁（否则会把
      // 「新回合已受理停止但尚未收尾」误判为已静默）。
      this.markTurnSettled(epoch, 'loop-finally')
    }
  }

  private async runLoopInner(
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
          // result 后等待下一条 enqueue 时，非终态消息属于旧 turn 的迟到尾声。
          // 否则 renderer 会把已完成会话重新 adopt 成 running。
          if (!isResult && !this.turnInFlight) continue

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
              void this.tryContextOverflowRecovery().then((recovered) => {
                if (recovered) {
                  this.state = 'closed' // 进程需重建；下次 send 会 re-spawn
                  // 软重置收尾：本轮并未成功完成，不得当作成功终态
                  this.onTurnEnd?.({ outcome: 'error' })
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
            // 本轮原生终态已观察到（长驻内核 result 后 loop 不退出，必须在此解除闩锁）
            this.markTurnSettled(epoch, 'result')
            // onTurnEnd **不是**成功专属：error_max_turns / error_during_execution /
            // paused_no_progress / max_tokens 等终态同样走到这里，故带上判定结果。
            if (wasInFlight) this.onTurnEnd?.({ outcome: classifyTurnTerminal(msg) })
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
            void this.tryContextOverflowRecovery().then((recovered) => {
              this.state = 'closed'
              if (!recovered) this.onError?.(new Error(formatPromptTooLongError()))
              // 软重置收尾：本轮未成功完成
              else this.onTurnEnd?.({ outcome: 'error' })
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
          void this.tryContextOverflowRecovery().then((recovered) => {
            this.state = 'closed'
            if (!recovered) this.onError?.(new Error(formatPromptTooLongError()))
            // 软重置收尾：本轮未成功完成
            else this.onTurnEnd?.({ outcome: 'error' })
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
   * - Official API connections never auto-replay: upstream delivery is ambiguous after a crash,
   *   so recovery must wait for an explicit user continuation / host handoff.
   * - Legacy local runtimes recover only when non-user-stop, below MAX_AUTO_RECOVERY, and a
   *   resumeSessionId plus in-flight message are available.
   * - 恢复 = 复用原 queryOptions 配置（canUseTool / mcpServers / systemPrompt 等），
   *   仅覆盖 resumeSessionId + prompt（重注入在飞消息）
   * - 重注入在飞消息可能造成「重复用户气泡」（SDK transcript 是否已落盘该消息不确定）；
   *   权衡：丢消息比重复气泡更糟，故选择重注入。后续可结合 resumeSessionAt / fork 精确去重。
   */
  /**
   * Phase 4：prompt_too_long 时尝试 kscc 软重置兜底（廉价清理 + 影子压缩切换）。
   * 动态 import 避免 runtime ↔ soft-reset 循环依赖启动成本。
   */
  private async tryContextOverflowRecovery(): Promise<boolean> {
    if (!this.onContextOverflow) return false
    try {
      return await this.onContextOverflow()
    } catch (e) {
      console.warn(`[会话 ${this.sessionId}] context overflow recovery failed:`, e)
      return false
    }
  }

  private attemptRecovery(
    queryOptions: Parameters<AgentProviderAdapter['query']>[0]
  ): Parameters<AgentProviderAdapter['query']>[0] | undefined {
    if (this.userClosing || this.userStopping) return undefined
    if (this.recoveryAttempts >= MAX_AUTO_RECOVERY) return undefined
    const nativeResume = queryOptions as {
      apiConnection?: unknown
      resumeSessionId?: string
      resumeThreadId?: string
    }
    // ADR-0012: do not silently replay the prior prompt through an official API connection.
    // A disconnect leaves upstream acceptance unknown; only an explicit later user send may resume.
    if (nativeResume.apiConnection) return undefined
    const resumeId =
      this.lastSdkSessionId ??
      nativeResume.resumeSessionId ??
      nativeResume.resumeThreadId
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
    const resumePatch =
      nativeResume.resumeThreadId !== undefined
        ? { resumeThreadId: resumeId }
        : { resumeSessionId: resumeId }
    return {
      ...queryOptions,
      ...resumePatch,
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
    // 在调适配器**之前**置位：适配器可能在 interruptQuery 内同步/即时推出终态，
    // 若先调用后置位会漏掉那次终态，导致闩锁永远挂着（假 fail-closed）。
    if (this.turnInFlight) this.stopSettlementPending = true
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
   * 本轮原生终态是否已观察不到（停止请求已被受理但 runLoop 还没看到终态）。
   * 供跨内核切换的静默判定使用：true = 旧内核可能仍有工具在收尾，必须 fail-closed。
   */
  hasUnsettledStop(): boolean {
    return this.stopSettlementPending
  }

  /**
   * 等待本轮原生终态（result / generator 结束 / 抛错收尾）被观察到。
   * @returns true = 已停稳；false = 超时（未能确认静默，调用方必须 fail-closed）
   */
  waitForTurnSettled(timeoutMs = 15_000): Promise<boolean> {
    if (!this.stopSettlementPending) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.settlementWaiters.indexOf(waiter)
        if (index >= 0) this.settlementWaiters.splice(index, 1)
        resolve(!this.stopSettlementPending)
      }, Math.max(0, timeoutMs))
      const waiter = () => {
        clearTimeout(timer)
        resolve(true)
      }
      this.settlementWaiters.push(waiter)
    })
  }

  /**
   * runLoop 观察到本轮原生终态时调用（幂等）。
   * 覆盖：收到 result；generator 结束退出；抛错收尾。
   *
   * @param epoch 调用方所属 loop 代数；与当前 loopEpoch 不一致（已被接替的旧圈）时
   *   不得清除闩锁，避免旧圈把**新回合**「已受理停止但未收尾」误判为已静默。
   */
  private markTurnSettled(epoch?: number, source: 'result' | 'loop-finally' = 'result'): void {
    if (epoch !== undefined && epoch !== this.loopEpoch) return
    // 配置换核时 result 不是充分条件：长驻 SDK 可能在 result 后继续保持 native
    // session/子进程。只有该退役 loop 真正退出（runLoop finally）才能放开下一轮。
    if (this.retiringLoopEpoch !== undefined && this.retiringLoopEpoch === epoch) {
      if (source !== 'loop-finally') return
      this.retiringLoopEpoch = undefined
    }
    if (!this.stopSettlementPending) return
    this.stopSettlementPending = false
    const waiters = this.settlementWaiters.splice(0, this.settlementWaiters.length)
    for (const waiter of waiters) waiter()
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
    const steer = this.adapter.steerMessage ?? this.adapter.sendQueuedMessage
    if (!steer) return 'noop'
    // 必须是完整 SDKUserMessage：缺 type/session_id 时 SDK 会丢弃，引导永远不生效。
    const steerInput: SDKUserMessageInput = {
      type: 'user',
      session_id: this.sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: message },
    }
    await steer.call(this.adapter, this.sessionId, steerInput)
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

  /**
   * 软中断是否仍在途（renderer 已把 UI 切到 stopped，主进程仍在等 adapter 收尾）。
   * 供运行内核切换等需要「真正静默」的判定使用（见 runtime-switch.ts）。
   */
  isInterrupting(): boolean {
    return this.interruptInFlight !== undefined
  }
}
