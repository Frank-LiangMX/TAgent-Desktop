/**
 * 会话协作目录 — 从时间线 DisplayItem 抽出班组/会诊/圆桌/子代理索引。
 *
 * 纯函数、零 DOM：渲染层扫 items 建目录，点击再 scrollIntoView。
 * 对照 docs/dev/ux/NESTED-COLLAB-OUTLINE-brief.md。
 */

import type {
  MoADiscussionPanel,
  MoARoundtablePanel,
  TAgentAssistantMessage,
  TAgentTextBlock,
} from '@tagent/shared'
import {
  findSubagentTaskTool,
  isCrewNoticeMessage,
  listSubagentEntryIds,
  type TurnSourceItem,
} from './session-turn-model'
import { isSubagentRuntimeTaskType, type TaskCardState } from './subagent-ui-model'

export type SessionCollabKind = 'consult' | 'discussion' | 'subagent' | 'crew'

export type SessionCollabStatus = 'running' | 'done' | 'error' | 'cancelled' | 'idle'

export interface SessionCollabItem {
  id: string
  kind: SessionCollabKind
  title: string
  status: SessionCollabStatus
  statusLabel: string
  subtitle?: string
  /** 与卡片 data-message-id 对齐，供跳转 */
  anchorKey: string
  discussionId?: string
  parentToolUseId?: string
  boardId?: string
  at?: number
}

export interface SessionCollabOutline {
  items: SessionCollabItem[]
  counts: Record<SessionCollabKind, number>
  runningCount: number
}

export interface CollabSourceItem {
  key: string
  moaRoundtable?: MoARoundtablePanel
  moaDiscussion?: MoADiscussionPanel
  taskCard?: TaskCardState
  message?: TurnSourceItem['message']
}

export interface CrewBoardSummary {
  id: string
  title?: string
  rootGoal?: string
  status?: string
  paused?: boolean
  updatedAt?: number
  running?: number
  ready?: number
  pending?: number
  done?: number
  failed?: number
  total?: number
}

const KIND_ORDER: SessionCollabKind[] = ['consult', 'discussion', 'crew', 'subagent']

export const COLLAB_KIND_LABEL: Record<SessionCollabKind, string> = {
  consult: '会诊',
  discussion: '圆桌',
  crew: '班组',
  subagent: '子代理',
}

const CONSULT_PHASE_LABEL: Record<MoARoundtablePanel['phase'], string> = {
  references: '交卷中',
  aggregating: '汇总中',
  done: '已汇总',
  error: '出错',
  cancelled: '已取消',
}

const DISCUSSION_PHASE_LABEL: Record<MoADiscussionPanel['phase'], string> = {
  discussing: '讨论中',
  finalizing: '收口中',
  done: '已完成',
  error: '出错',
  cancelled: '已取消',
}

function emptyCounts(): Record<SessionCollabKind, number> {
  return { consult: 0, discussion: 0, crew: 0, subagent: 0 }
}

function consultStatus(phase: MoARoundtablePanel['phase']): SessionCollabStatus {
  if (phase === 'references' || phase === 'aggregating') return 'running'
  if (phase === 'done') return 'done'
  if (phase === 'error') return 'error'
  return 'cancelled'
}

function discussionStatus(phase: MoADiscussionPanel['phase']): SessionCollabStatus {
  if (phase === 'discussing' || phase === 'finalizing') return 'running'
  if (phase === 'done') return 'done'
  if (phase === 'error') return 'error'
  return 'cancelled'
}

function subagentStatus(status: TaskCardState['status'] | undefined): SessionCollabStatus {
  if (status === 'running' || status == null) return status === 'running' ? 'running' : 'idle'
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'error'
  return 'cancelled'
}

function subagentStatusLabel(status: TaskCardState['status'] | undefined): string {
  if (status === 'running') return '运行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'stopped') return '已停止'
  return '已派发'
}

function truncate(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

function topicOf(topic: string, fallback: string): string {
  return truncate(topic, 48) || fallback
}

function launcherTitle(items: CollabSourceItem[], parentToolUseId: string): string {
  const launcher = findSubagentTaskTool(items as TurnSourceItem[], parentToolUseId)
  const desc = launcher?.input?.description ?? launcher?.input?.prompt
  if (typeof desc === 'string' && desc.trim()) return truncate(desc, 48)
  return ''
}

function fromConsult(item: CollabSourceItem, panel: MoARoundtablePanel): SessionCollabItem {
  const refs = panel.seats.filter((s) => s.role === 'reference')
  const done = refs.filter((s) => s.status === 'ok' || s.status === 'failed').length
  const status = consultStatus(panel.phase)
  return {
    id: `consult:${panel.roundtableId}`,
    kind: 'consult',
    title: topicOf(panel.topic, panel.presetName || '会诊'),
    status,
    statusLabel: CONSULT_PHASE_LABEL[panel.phase],
    subtitle: `${done}/${refs.length || panel.seats.length} 席 · ${panel.presetName}`,
    anchorKey: item.key || `moa-${panel.roundtableId}`,
  }
}

function fromDiscussion(item: CollabSourceItem, panel: MoADiscussionPanel): SessionCollabItem {
  const last = panel.entries[panel.entries.length - 1]
  const lastSpeaker = last
    ? panel.speakers.find((s) => s.speakerId === last.speakerId)?.name
    : undefined
  const participants = panel.speakers.filter((s) => s.role === 'participant').length
  return {
    id: `discussion:${panel.discussionId}`,
    kind: 'discussion',
    title: topicOf(panel.topic, panel.presetName || '圆桌'),
    status: discussionStatus(panel.phase),
    statusLabel: DISCUSSION_PHASE_LABEL[panel.phase],
    subtitle: `第 ${panel.currentRound}/${panel.roundLimit} 轮 · ${participants} 席${
      lastSpeaker ? ` · ${lastSpeaker}` : ''
    }`,
    anchorKey: item.key || `disc-${panel.discussionId}`,
    discussionId: panel.discussionId,
    at: last?.createdAt,
  }
}

function fromSubagent(
  items: CollabSourceItem[],
  parentToolUseId: string,
  card: TaskCardState | undefined,
): SessionCollabItem {
  const title =
    (card?.description ? truncate(card.description, 48) : '') ||
    launcherTitle(items, parentToolUseId) ||
    '子代理任务'
  const subtitle = card?.summary
    ? truncate(card.summary, 42)
    : card?.progressText || (card?.lastToolName ? `运行工具：${card.lastToolName}` : undefined)
  return {
    id: `subagent:${parentToolUseId}`,
    kind: 'subagent',
    title,
    status: subagentStatus(card?.status),
    statusLabel: subagentStatusLabel(card?.status),
    subtitle,
    anchorKey: `subagent-${parentToolUseId}`,
    parentToolUseId,
    at: card?.startedAt ?? card?.endedAt,
  }
}

function crewNoticeText(message: TAgentAssistantMessage): string {
  for (const b of message.content) {
    if (b.type === 'text' && typeof (b as TAgentTextBlock).text === 'string') {
      const t = (b as TAgentTextBlock).text.trim()
      if (t) return t
    }
  }
  return ''
}

function fromCrewNotice(item: CollabSourceItem, message: TAgentAssistantMessage): SessionCollabItem {
  const raw = crewNoticeText(message)
  const firstLine = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const titled = firstLine.replace(/^【班组完成】/, '').trim()
  const stats = raw.match(/合计\s*(\d+)\s*项：完成\s*(\d+)，失败\s*(\d+)/)
  const failed = stats ? Number(stats[3]) : 0
  return {
    id: `crew:${item.key}`,
    kind: 'crew',
    title: topicOf(titled, '班组'),
    status: failed > 0 ? 'error' : 'done',
    statusLabel: failed > 0 ? '有失败' : '已完成',
    subtitle: stats ? `${stats[2]}/${stats[1]} 完成` : undefined,
    anchorKey: item.key,
  }
}

export function crewBoardToCollabItem(board: CrewBoardSummary): SessionCollabItem {
  const total = board.total ?? 0
  const running = board.running ?? 0
  const ready = (board.ready ?? 0) + (board.pending ?? 0)
  const done = board.done ?? 0
  const failed = board.failed ?? 0
  const paused = Boolean(board.paused)
  let status: SessionCollabStatus = 'idle'
  let statusLabel = board.status === 'completed' ? '已收工' : board.status === 'cancelled' ? '已取消' : '待命'
  if (board.status === 'cancelled') {
    status = 'cancelled'
  } else if (failed > 0 && running === 0) {
    status = 'error'
    statusLabel = '有失败'
  } else if (running > 0) {
    status = 'running'
    statusLabel = paused ? '已暂停' : '执行中'
  } else if (board.status === 'completed' || (total > 0 && done === total)) {
    status = 'done'
    statusLabel = '已完成'
  } else if (ready > 0) {
    status = 'idle'
    statusLabel = '排队中'
  }

  const bits: string[] = []
  if (total > 0) bits.push(`${done}/${total} 完成`)
  if (running > 0) bits.push(`${running} 执行中`)
  if (ready > 0) bits.push(`${ready} 排队`)
  if (failed > 0) bits.push(`${failed} 失败`)

  return {
    id: `crew:${board.id}`,
    kind: 'crew',
    title: topicOf(board.title || board.rootGoal || '', '班组看板'),
    status,
    statusLabel,
    subtitle: bits.join(' · ') || undefined,
    anchorKey: `crew-${board.id}`,
    boardId: board.id,
    at: board.updatedAt,
  }
}

/**
 * 从时间线 items 抽出会诊 / 圆桌 / 子代理。班组走看板 API，由 UI 再 merge。
 */
export function collectSessionCollabOutline(items: CollabSourceItem[]): SessionCollabOutline {
  const collected: SessionCollabItem[] = []
  const seenConsult = new Set<string>()
  const seenDisc = new Set<string>()

  for (const it of items) {
    const consult = it.moaRoundtable
    if (consult && !seenConsult.has(consult.roundtableId)) {
      seenConsult.add(consult.roundtableId)
      collected.push(fromConsult(it, consult))
    }
    const disc = it.moaDiscussion
    if (disc && !seenDisc.has(disc.discussionId)) {
      seenDisc.add(disc.discussionId)
      collected.push(fromDiscussion(it, disc))
    }
  }

  const subagentIds = listSubagentEntryIds(items as TurnSourceItem[])
  const cardByTool = new Map<string, TaskCardState>()
  for (const it of items) {
    const card = it.taskCard
    if (card?.toolUseId && isSubagentRuntimeTaskType(card.taskType)) {
      cardByTool.set(card.toolUseId, card)
    }
  }
  for (const id of subagentIds) {
    collected.push(fromSubagent(items, id, cardByTool.get(id)))
  }

  for (const it of items) {
    const m = it.message
    if (m?.type === 'assistant' && isCrewNoticeMessage(m)) {
      collected.push(fromCrewNotice(it, m))
    }
  }

  const counts = emptyCounts()
  let runningCount = 0
  for (const item of collected) {
    counts[item.kind] += 1
    if (item.status === 'running') runningCount += 1
  }

  return { items: collected, counts, runningCount }
}

export function mergeCrewIntoOutline(
  outline: SessionCollabOutline,
  boards: CrewBoardSummary[],
): SessionCollabOutline {
  const crewItems = boards.map(crewBoardToCollabItem)
  const items = [...outline.items, ...crewItems]
  const counts = { ...outline.counts, crew: crewItems.length }
  const runningCount =
    outline.runningCount + crewItems.filter((it) => it.status === 'running').length
  return { items, counts, runningCount }
}

export function groupCollabItems(
  items: SessionCollabItem[],
  filter: SessionCollabKind | 'all' = 'all',
): Array<{ kind: SessionCollabKind; items: SessionCollabItem[] }> {
  const groups: Array<{ kind: SessionCollabKind; items: SessionCollabItem[] }> = []
  for (const kind of KIND_ORDER) {
    if (filter !== 'all' && filter !== kind) continue
    const list = items.filter((it) => it.kind === kind)
    if (list.length > 0) groups.push({ kind, items: list })
  }
  return groups
}

export function runningCollabItems(items: SessionCollabItem[]): SessionCollabItem[] {
  return items.filter((it) => it.status === 'running')
}
