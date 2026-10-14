/** 发送消息只代表启动回合；日报必须等原生成功终态后才能记为成功。 */
export class WpsTurnCompletion {
  private pending = new Map<string, (success: boolean) => void>()

  wait(sessionId: string, timeoutMs = 15 * 60_000): { promise: Promise<void>; cancel: () => void } {
    if (this.pending.has(sessionId)) throw new Error('WPS 日报回合已在运行。')
    let cancel = (): void => {}
    const promise = new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); this.pending.delete(sessionId) }
      const timer = setTimeout(() => { cleanup(); reject(new Error('WPS 日报生成超时，未标记完成。')) }, timeoutMs)
      this.pending.set(sessionId, success => { cleanup(); success ? resolve() : reject(new Error('WPS 日报生成出错或被停止，未标记完成。')) })
      cancel = () => { cleanup(); resolve() }
    })
    // 原生事件可能在发送方法 await 期间触发，提前挂拒绝处理防止未处理拒绝。
    void promise.catch(() => {})
    return { promise, cancel: () => cancel() }
  }

  settle(sessionId: string, success: boolean): void { this.pending.get(sessionId)?.(success) }
}
