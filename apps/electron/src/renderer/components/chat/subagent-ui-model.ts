/**
 * 子代理 UI 纯函数模型
 *
 * 抽离两块无副作用的 UI 逻辑，便于在 vitest（node 环境）直接单测：
 * 1. 子代理委派积极性（subagentEagerness）的 UI 配置 + 解析
 * 2. Chat 流式事件 → 任务卡片状态机（task_started / task_progress / task_notification）
 *
 * 不依赖 React / DOM，只吃 @tagent/shared 类型。Chat.tsx 与 MessageView.tsx 复用。
 */
import type { TAgentMessage, TAgentTextBlock } from '@tagent/shared'
import {
  migrateSubagentEagerness,
  type SubagentEagerness,
} from '@tagent/shared'

// ===== 子代理委派积极性（UI 配置） =====

export interface SubagentEagernessOption {
  /** 短标签（选择器展示） */
  label: string
  /** 一句话说明（选择器下拉项副标题） */
  description: string
}

/** 选择器展示顺序：从不 → 保守 → 均衡 → 激进 */
export const SUBAGENT_EAGERNESS_ORDER: readonly SubagentEagerness[] = [
  'never',
  'conservative',
  'balanced',
  'aggressive',
]

/** 委派积极性 UI 配置（中文文案，对齐 PermissionModeSelector 风格） */
export const SUBAGENT_EAGERNESS_CONFIG: Record<SubagentEagerness, SubagentEagernessOption> = {
  never: {
    label: '从不',
    description: '不主动委派子代理，仅用户明确要求时使用',
  },
  conservative: {
    label: '保守',
    description: '明确有益才委派（探索/审查/调研），默认',
  },
  balanced: {
    label: '均衡',
    description: '积极委派，保持主上下文干净',
  },
  aggressive: {
    label: '激进',
    description: '尽可能委派，主会话只做编排与决策',
  },
}

/**
 * 从会话 meta 解析委派积极性（缺省 / 非法值回退默认 conservative）。
 * 用于 Chat 挂载时回显持久化档位。
 */
export function resolveEagerness(
  meta?: { subagentEagerness?: SubagentEagerness },
): SubagentEagerness {
  return migrateSubagentEagerness(meta?.subagentEagerness)
}

// ===== 文本摘要（子代理折叠头 / minimap 复用） =====

/** 取消息首个 text 块的文本（user / assistant 通用） */
export function extractFirstText(message: TAgentMessage): string | undefined {
  for (const block of message.content) {
    if (block.type === 'text') {
      return (block as TAgentTextBlock).text
    }
  }
  return undefined
}

/** 一行摘要：首段 text 压空白后截断（供子代理折叠头展示） */
export function summarizeFirstText(message: TAgentMessage, max = 120): string {
  const text = extractFirstText(message)
  if (!text) return ''
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

// ===== 任务卡片状态机 =====

/**
 * 任务卡片状态（子代理运行时生命周期）。
 * 渲染为消息流中独立小卡片（圆角边框 + 状态色 + 进度文案 / 收口摘要）。
 */
export interface TaskCardState {
  /** 子任务 ID（SDK task_id，匹配 task_progress / task_notification） */
  taskId: string
  /** 父 tool_use_id（task_progress 仅带 toolUseId 时的回退匹配键） */
  toolUseId?: string
  /** 任务描述（task_started 给出，收口后保留展示） */
  description: string
  /** 生命周期状态 */
  status: 'running' | 'completed' | 'failed' | 'stopped'
  /** 最近一次工具名（task_progress 更新） */
  lastToolName?: string
  /** 收口摘要（task_notification 给出） */
  summary?: string
  /** 进度文案（来自 description / lastToolName）；收口后清空 */
  progressText?: string
}

/**
 * 任务卡片事件（对齐 sdkMessageToIR 输出的 tagent_event 子集）。
 * Chat.handlePayload 把流式 tagent_event 归一成此联合后喂给 reduceTaskEvent。
 */
export type TaskCardEvent =
  | { type: 'task_started'; taskId: string; toolUseId?: string; description: string }
  | {
      type: 'task_progress'
      taskId?: string
      toolUseId?: string
      description?: string
      lastToolName?: string
    }
  | {
      type: 'task_notification'
      taskId: string
      toolUseId?: string
      status: 'completed' | 'failed' | 'stopped'
      summary: string
    }

/**
 * 任务卡片承载项：消息流中任意一项，可携带一张任务卡片。
 * Chat 的 DisplayItem 满足此契约（额外字段如 message/streamingText 互不影响）。
 */
export interface TaskCardCarrier {
  /** 稳定 key */
  key: string
  /** 任务卡片（有则渲染为卡片，否则为普通消息） */
  taskCard?: TaskCardState
}

/**
 * 进度文案格式化：优先 description，其次 lastToolName，否则 undefined。
 * 对齐 brief「progressText 来自 description / lastToolName」。
 */
export function formatProgressText(event: {
  description?: string
  lastToolName?: string
}): string | undefined {
  const desc = event.description?.trim()
  if (desc) return desc
  if (event.lastToolName) return `运行工具：${event.lastToolName}`
  return undefined
}

/** 按 taskId / toolUseId 在已有卡片中定位下标（taskId 优先，toolUseId 回退） */
function findCardIndex<T extends TaskCardCarrier>(
  items: readonly T[],
  taskId: string | undefined,
  toolUseId: string | undefined,
): number {
  if (taskId) {
    const i = items.findIndex((it) => it.taskCard?.taskId === taskId)
    if (i >= 0) return i
  }
  if (toolUseId) {
    const i = items.findIndex((it) => it.taskCard?.toolUseId === toolUseId)
    if (i >= 0) return i
  }
  return -1
}

/**
 * 任务卡片状态机 reducer（纯函数）。
 *
 * 生命周期：task_started 建卡（running）→ task_progress 更新同一卡片进度文案（不新增气泡）
 *           → task_notification 收口（status + summary，清空进度文案）。
 *
 * 三类事件均 upsert：命中已有卡片则就地更新（保留 key），未命中则追加。reducer 自身不构造
 * 承载项（避免对泛型 T 做 spread 触发 TS「generic spread」报错），改由调用方通过 apply 回调
 * 决定：existing 为 undefined 表示新建（分配 key），否则就地更新（保留 key 与其他字段）。
 *
 * @param items 当前消息流
 * @param event 任务卡片事件
 * @param apply 承载项工厂：existing=undefined 新建，否则用新卡片状态更新现有项
 */
export function reduceTaskEvent<T extends TaskCardCarrier>(
  items: readonly T[],
  event: TaskCardEvent,
  apply: (existing: T | undefined, card: TaskCardState) => T,
): T[] {
  switch (event.type) {
    case 'task_started': {
      const card: TaskCardState = {
        taskId: event.taskId,
        toolUseId: event.toolUseId,
        description: event.description,
        status: 'running',
        progressText: event.description.trim() ? event.description.trim() : '启动中…',
      }
      const idx = findCardIndex(items, event.taskId, event.toolUseId)
      const existing = idx >= 0 ? items[idx] : undefined
      if (existing) {
        // 已有卡片（如 progress 先于 started 到达）：重置为 running，保留心跳里的 lastToolName
        const prev = existing.taskCard
        const merged: TaskCardState = { ...card, lastToolName: prev?.lastToolName }
        return items.map((it, i) => (i === idx ? apply(it, merged) : it))
      }
      return [...items, apply(undefined, card)]
    }

    case 'task_progress': {
      const progressText = formatProgressText(event)
      const idx = findCardIndex(items, event.taskId, event.toolUseId)
      const existing = idx >= 0 ? items[idx] : undefined
      if (existing) {
        const prev = existing.taskCard
        // 已收口的卡片不再被进度事件复活；findCardIndex 命中即说明 taskCard 存在，再防御一次
        if (!prev || prev.status !== 'running') return [...items]
        const merged: TaskCardState = {
          ...prev,
          lastToolName: event.lastToolName ?? prev.lastToolName,
          progressText,
        }
        return items.map((it, i) => (i === idx ? apply(it, merged) : it))
      }
      // 无卡片承载进度（progress 早于 started 到达）：建一张 running 卡片，避免丢失信号（仅一次 append）
      const card: TaskCardState = {
        taskId: event.taskId ?? event.toolUseId ?? '',
        toolUseId: event.toolUseId,
        description: '',
        status: 'running',
        lastToolName: event.lastToolName,
        progressText,
      }
      return [...items, apply(undefined, card)]
    }

    case 'task_notification': {
      const summary = event.summary
      const idx = findCardIndex(items, event.taskId, event.toolUseId)
      const existing = idx >= 0 ? items[idx] : undefined
      if (existing) {
        const prev = existing.taskCard
        if (!prev) return [...items]
        const merged: TaskCardState = {
          ...prev,
          status: event.status,
          summary,
          progressText: undefined,
        }
        return items.map((it, i) => (i === idx ? apply(it, merged) : it))
      }
      // 无卡片（started 丢失）：直接建一张已收口的卡片
      const card: TaskCardState = {
        taskId: event.taskId,
        toolUseId: event.toolUseId,
        description: '',
        status: event.status,
        summary,
      }
      return [...items, apply(undefined, card)]
    }
  }
}
