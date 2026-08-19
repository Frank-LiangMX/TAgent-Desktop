/**
 * 会话是否仍有未完成工作（工具循环 / 子代理 / 圆桌）。
 *
 * turn_end 只表示 SDK **单轮**结束。若此时还有未配对的 tool_use，
 * 主会话其实在等回调，不得软/硬停，也不得把运行计时从 0 重计。
 */

export type InFlightContentBlock = {
  type?: string
  id?: string
  toolUseId?: string
}

export type InFlightMessage = {
  type?: string
  parentToolUseId?: string | null
  content?: InFlightContentBlock[]
}

export type InFlightWorkItem = {
  message?: InFlightMessage
  taskCard?: { status?: string }
  moaRoundtable?: { phase?: string }
  moaDiscussion?: { phase?: string }
}

/** 主线消息同步更新「未完成 tool_use」集合（跳过子代理 parented）。 */
export function applyMessageToInFlightToolIds(
  ids: Set<string>,
  message: InFlightMessage | null | undefined,
): void {
  if (!message || message.parentToolUseId) return
  if (message.type === 'assistant') {
    for (const block of message.content ?? []) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && block.id) {
        ids.add(block.id)
      }
    }
    return
  }
  if (message.type === 'user') {
    for (const block of message.content ?? []) {
      if (block.type === 'tool_result' && typeof block.toolUseId === 'string' && block.toolUseId) {
        ids.delete(block.toolUseId)
      }
    }
  }
}

/** 从当前 items 重建未完成 tool_use（历史加载 / 对账）。 */
export function collectPendingToolUseIds(items: InFlightWorkItem[]): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    applyMessageToInFlightToolIds(ids, item.message)
  }
  return ids
}

export function sessionHasInFlightWork(input: {
  pendingToolUseIds?: Iterable<string>
  items?: InFlightWorkItem[]
  /** AskUser / 权限 / 退出计划等弹窗：人还没选，本轮没完 */
  awaitingUser?: boolean
}): boolean {
  if (input.awaitingUser) return true
  if (input.pendingToolUseIds) {
    for (const _id of input.pendingToolUseIds) {
      return true
    }
  }
  for (const item of input.items ?? []) {
    if (item.taskCard?.status === 'running') return true
    const roundtablePhase = item.moaRoundtable?.phase
    if (roundtablePhase === 'references' || roundtablePhase === 'aggregating') return true
    const discussionPhase = item.moaDiscussion?.phase
    if (discussionPhase === 'discussing' || discussionPhase === 'finalizing') return true
  }
  return false
}

/** turn_end 后是否安排停表：有在途工作则否。 */
export function shouldScheduleRunStopAfterTurnEnd(hasOpenWork: boolean): boolean {
  return !hasOpenWork
}

/**
 * 继续一轮时的计时起点：已有记忆优先，禁止用 now 覆盖。
 * 工具间隙把已走时长叠加上去，而不是从 0 开新一轮。
 */
export function resolveAdoptStartedAt(
  prevStartedAt: number | null | undefined,
  memoryStartedAt: number | null | undefined,
  fallbackStartedAt: number,
): number {
  return prevStartedAt ?? memoryStartedAt ?? fallbackStartedAt
}
