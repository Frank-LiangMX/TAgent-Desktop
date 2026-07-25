/**
 * 长生命周期消息通道（两核共用）
 *
 * 从 TAgent 搬迁，原样保留。这是 SDK streamInput 的持久化 AsyncGenerator：
 * generator 不 return → SDK 不 endInput → 子进程 stdin 不关 → 进程长驻。
 *
 * 2.0 长驻模式下，这正是"会话=进程常驻"的底层支撑：
 * - 首条消息 enqueue + 起 query，generator 持续 yield
 * - result 后不 close（长驻），等下条 enqueue
 * - 会话关闭才 close → SDK endInput → 进程 EOF 退出
 */
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export interface MessageChannel {
  /** 向队列推送消息（非阻塞） */
  enqueue: (msg: SDKUserMessage) => void
  /** 供 SDK streamInput() 消费的长生命周期 AsyncGenerator */
  generator: AsyncGenerator<SDKUserMessage>
  /** 优雅关闭：标记 generator 结束，排空剩余后返回，让 SDK endInput 关 stdin */
  close: () => void
}

export function createMessageChannel(signal: AbortSignal): MessageChannel {
  const queue: SDKUserMessage[] = []
  let resolver: ((value: void) => void) | null = null
  let done = signal.aborted

  if (!done) {
    signal.addEventListener(
      'abort',
      () => {
        done = true
        if (resolver) {
          const r = resolver
          resolver = null
          r()
        }
      },
      { once: true }
    )
  }

  async function* generator(): AsyncGenerator<SDKUserMessage> {
    while (!done) {
      if (queue.length > 0) {
        yield queue.shift()!
      } else {
        await new Promise<void>((resolve) => {
          resolver = resolve
        })
      }
    }
    while (queue.length > 0) {
      yield queue.shift()!
    }
  }

  return {
    enqueue: (msg: SDKUserMessage) => {
      queue.push(msg)
      if (resolver) {
        const r = resolver
        resolver = null
        r()
      }
    },
    generator: generator(),
    close: () => {
      done = true
      if (resolver) {
        const r = resolver
        resolver = null
        r()
      }
    },
  }
}
