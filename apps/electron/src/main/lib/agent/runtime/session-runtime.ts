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
 */
import type { AgentProviderAdapter, SDKMessage, SDKUserMessageInput } from '@tagent/shared'

export type SessionState = 'idle' | 'running' | 'closed'

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

    // 首次：spawn + 起持续循环
    if (!this.hasLiveProcess()) {
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
    this.turnInFlight = true
    await this.adapter.sendQueuedMessage?.(this.sessionId, userMessage)
  }

  /** 起持续事件循环（首次） */
  private async startLoop(
    queryOptions: Parameters<AgentProviderAdapter['query']>[0]
  ): Promise<void> {
    this.loopRunning = true
    this.turnInFlight = true
    this.state = 'running'

    // 异步跑循环，不阻塞 sendMessage
    void this.runLoop(queryOptions)
  }

  /** 持续事件循环：遍历 adapter.query 流，result 后不退，等下条 */
  private async runLoop(
    queryOptions: Parameters<AgentProviderAdapter['query']>[0]
  ): Promise<void> {
    try {
      const iterable = this.adapter.query(queryOptions)
      for await (const msg of iterable) {
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

        if (msg.type === 'result') {
          // 每轮 result：标记轮结束，发 turnEnd 信号（UI 知道这轮完）
          // 循环不退，等下条 enqueue 触发新轮
          this.turnInFlight = false
          this.onTurnEnd?.()
        }
      }
      // 循环退出 = 进程退出（iterResult.done）/ abort
      this.loopRunning = false
      this.state = 'closed'
    } catch (err) {
      this.loopRunning = false
      this.state = 'closed'
      this.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /** 软中断当前 turn（保进程） */
  async interrupt(): Promise<void> {
    await this.adapter.interruptQuery?.(this.sessionId)
    this.turnInFlight = false
  }

  /** 销毁会话：杀进程（标签页关/被顶、关 TAgent） */
  destroy(): void {
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
