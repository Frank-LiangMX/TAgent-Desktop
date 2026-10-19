import type { TAgentDesktopStreamPayload } from '@tagent/shared'

/** Bound full-snapshot IPC frequency; final/control events are never delayed. */
export class CodexSnapshotPublisher {
  private readonly pending = new Map<string, TAgentDesktopStreamPayload>()
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  constructor(private readonly emit: (payload: TAgentDesktopStreamPayload) => void) {}

  publish(payload: TAgentDesktopStreamPayload): void {
    if (this.closed) return
    if (payload.kind === 'sdk_message' && payload.message.type === 'assistant'
      && payload.message._partial && payload.message.uuid
      && !payload.message.content.some(b => b.type === 'tool_use')) {
      this.pending.set(payload.message.uuid, payload)
      this.timer ??= setTimeout(() => this.flush(), 50)
      return
    }
    this.flush()
    this.emit(payload)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const payload of this.pending.values()) this.emit(payload)
    this.pending.clear()
  }

  dispose(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
  }
}
