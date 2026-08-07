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
  /**
   * SDK `task_type` / `subagent_type`（如 `local_agent`）。
   * 建卡白名单依据；`local_bash` 等本机工具不得进子代理 UI。
   */
  taskType?: string
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
  | {
      type: 'task_started'
      taskId: string
      toolUseId?: string
      description: string
      /** SDK task_type；缺省或非 agent → 不建卡 */
      taskType?: string
    }
  | {
      type: 'task_progress'
      taskId?: string
      toolUseId?: string
      description?: string
      lastToolName?: string
      taskType?: string
    }
  | {
      type: 'task_notification'
      taskId: string
      toolUseId?: string
      status: 'completed' | 'failed' | 'stopped'
      summary: string
      taskType?: string
    }

/**
 * SDK `task_*` 的 runtime type 白名单：只有真子代理。
 *
 * Claude/kscc 会对 **local_bash（本机 Bash）与 local_agent（子代理）** 都发 task_started；
 * 若按「凡 task_* 即子代理」或只黑名单一个 local_bash，下一个 local_xxx 仍会漏进来。
 * **默认拒绝，仅放行明确 agent 类型**——收口策略，不再个案加黑名单。
 */
export function isSubagentRuntimeTaskType(taskType: string | null | undefined): boolean {
  if (!taskType) return false
  const t = taskType.trim().toLowerCase().replace(/-/g, '_')
  if (!t) return false
  // 明确白名单（可按 SDK 演进追加，禁止改成「不等于 local_bash」）
  if (t === 'local_agent' || t === 'agent') return true
  // 保守：`*_agent` 且不含 bash/shell/command（防 local_bash_agent 之类臆造）
  if (t.endsWith('_agent') && !/(bash|shell|command|cmd)/.test(t)) return true
  return false
}

/** 是否允许用本事件**新建**子代理任务卡（更新已有卡不走此门） */
export function canCreateSubagentTaskCard(event: {
  taskType?: string
}): boolean {
  return isSubagentRuntimeTaskType(event.taskType)
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
      const idx = findCardIndex(items, event.taskId, event.toolUseId)
      // 白名单：非 agent runtime 不建卡；若误建过则直接摘掉
      if (!canCreateSubagentTaskCard(event)) {
        if (idx < 0) return [...items]
        return items.filter((_, i) => i !== idx)
      }
      const card: TaskCardState = {
        taskId: event.taskId,
        toolUseId: event.toolUseId,
        taskType: event.taskType,
        description: event.description,
        status: 'running',
        progressText: event.description.trim() ? event.description.trim() : '启动中…',
      }
      const existing = idx >= 0 ? items[idx] : undefined
      if (existing) {
        const prev = existing.taskCard
        const merged: TaskCardState = {
          ...card,
          lastToolName: prev?.lastToolName,
          taskType: event.taskType ?? prev?.taskType,
        }
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
      // 无卡时禁止用 progress 新建——否则 Bash 心跳也会冒充子代理入口
      if (!canCreateSubagentTaskCard(event)) return [...items]
      const card: TaskCardState = {
        taskId: event.taskId ?? event.toolUseId ?? '',
        toolUseId: event.toolUseId,
        taskType: event.taskType,
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
      // 无卡时禁止 notification 新建（同 progress）
      if (!canCreateSubagentTaskCard(event)) return [...items]
      const card: TaskCardState = {
        taskId: event.taskId,
        toolUseId: event.toolUseId,
        taskType: event.taskType,
        description: '',
        status: event.status,
        summary,
      }
      return [...items, apply(undefined, card)]
    }
  }
}
