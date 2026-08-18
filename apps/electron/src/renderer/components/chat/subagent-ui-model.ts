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
    description: '明确有益才委派（探索/审查/调研）',
  },
  balanced: {
    label: '均衡',
    description: '积极委派，保持主上下文干净（默认）',
  },
  aggressive: {
    label: '激进',
    description: '尽可能委派，主会话只做编排与决策',
  },
}

/**
 * 从会话 meta 解析委派积极性。
 * - meta 有合法档位 → 用会话档（per-session 覆盖）
 * - meta 缺省 → 用 fallback（全局默认，设置页「子代理」可配；再缺则 conservative）
 * - meta 非法 → migrate 回 conservative（不静默吃 fallback，避免脏 meta 伪装成用户默认）
 */
export function resolveEagerness(
  meta?: { subagentEagerness?: SubagentEagerness },
  fallback: SubagentEagerness = migrateSubagentEagerness(undefined),
): SubagentEagerness {
  if (meta?.subagentEagerness !== undefined) {
    return migrateSubagentEagerness(meta.subagentEagerness)
  }
  return migrateSubagentEagerness(fallback)
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
  /** 开始时间（ms）；task_started / 历史回填写入，供详情页耗时，避免「运行了 0.0s」 */
  startedAt?: number
  /** 结束时间（ms）；notification / 历史 tool_result 写入 */
  endedAt?: number
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

/** 主线 launcher 工具名（与 session-turn-model.isSubagentLauncherTool 对齐） */
function isHistorySubagentLauncher(name: string): boolean {
  const n = name.trim().toLowerCase()
  return n === 'agent' || n === 'task'
}

/**
 * 从已落盘历史回填子代理入口卡（纯函数）。
 *
 * 产品契约（用户可接受「详情过程不落盘」，但必须有）：
 * 1. **派过** = 主线 assistant 上的 tool_use（task/Agent）
 * 2. **结论** = 对应 tool_result 正文
 *
 * 运行时 taskCard 只靠 tagent_event（不落盘），重启后入口会「没了」。
 * 加载历史时用 launcher + tool_result 合成 completed/failed 卡，挂在发起该 task 的 assistant 后。
 */
export function rehydrateSubagentTaskCardsFromHistory<
  T extends TaskCardCarrier & { message?: TAgentMessage },
>(
  items: readonly T[],
  apply: (existing: T | undefined, card: TaskCardState) => T,
): T[] {
  // 先扫一遍 tool_result：toolUseId → 结论文本
  const conclusions = new Map<string, { text: string; isError: boolean }>()
  for (const it of items) {
    const m = it.message
    if (!m || m.type !== 'user') continue
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue
      const tr = b as {
        toolUseId?: string
        content?: unknown
        isError?: boolean
      }
      const id = typeof tr.toolUseId === 'string' ? tr.toolUseId : ''
      if (!id) continue
      let text = ''
      if (typeof tr.content === 'string') text = tr.content
      else if (Array.isArray(tr.content)) {
        text = tr.content
          .map((x) =>
            x && typeof x === 'object' && (x as { type?: string }).type === 'text'
              ? String((x as { text?: string }).text ?? '')
              : '',
          )
          .join('')
      } else if (tr.content != null) {
        try {
          text = JSON.stringify(tr.content)
        } catch {
          text = String(tr.content)
        }
      }
      conclusions.set(id, { text, isError: tr.isError === true })
    }
  }

  const out: T[] = []
  const seen = new Set<string>()
  for (const it of items) {
    out.push(it)
    // 已有运行时卡则不重复造
    if (it.taskCard?.toolUseId) seen.add(it.taskCard.toolUseId)

    const m = it.message
    if (!m || m.type !== 'assistant' || m.parentToolUseId) continue
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue
      const tu = b as {
        id?: string
        name?: string
        input?: Record<string, unknown>
      }
      const id = typeof tu.id === 'string' ? tu.id : ''
      const name = typeof tu.name === 'string' ? tu.name : ''
      if (!id || !isHistorySubagentLauncher(name) || seen.has(id)) continue
      seen.add(id)

      const input = tu.input ?? {}
      const descRaw =
        (typeof input.description === 'string' && input.description.trim()) ||
        (typeof input.prompt === 'string' && input.prompt.trim()) ||
        '子代理任务'
      const description = descRaw.replace(/\s+/g, ' ').slice(0, 140)
      const subType =
        typeof input.subagent_type === 'string' && input.subagent_type.trim()
          ? input.subagent_type.trim()
          : 'local_agent'
      const conc = conclusions.get(id)
      const summaryText = conc?.text?.replace(/\s+/g, ' ').trim() ?? ''
      // 结论消息时间：扫 user tool_result 的 createdAt（无 parented 消息时作 endedAt 回退）
      let resultAt: number | undefined
      for (const it2 of items) {
        const m2 = it2.message
        if (!m2 || m2.type !== 'user') continue
        for (const b2 of m2.content) {
          if (b2.type === 'tool_result' && (b2 as { toolUseId?: string }).toolUseId === id) {
            if (typeof m2.createdAt === 'number') resultAt = m2.createdAt
          }
        }
      }
      // 真实结束时刻：末条 parented（子代理自己的 assistant/user）消息 createdAt。
      // 不用 launcher 的 stub tool_result 时间——派发后 9–23ms 的占位，会让卡片显示「秒完」，
      // 而真实子代理工作 52–218s。见 SESSION-UX-RESIDUAL-SPEC §5。
      let parentedEndAt: number | undefined
      for (const it2 of items) {
        const m2 = it2.message
        if (!m2 || m2.parentToolUseId !== id) continue
        if (typeof m2.createdAt === 'number') {
          if (parentedEndAt === undefined || m2.createdAt > parentedEndAt) {
            parentedEndAt = m2.createdAt
          }
        }
      }
      const card: TaskCardState = {
        taskId: id,
        toolUseId: id,
        taskType: subType,
        description,
        status: conc ? (conc.isError ? 'failed' : 'completed') : 'stopped',
        summary: summaryText
          ? summaryText.length > 160
            ? `${summaryText.slice(0, 160)}…`
            : summaryText
          : '（无回传结论）',
        // 历史：起点用发起 task 的 assistant 时间戳
        startedAt: typeof m.createdAt === 'number' ? m.createdAt : undefined,
        // 末条 parented 消息 createdAt 优先；无 parented（子代理过程未落盘）回退 stub tool_result 时间
        endedAt: parentedEndAt ?? resultAt,
      }
      out.push(apply(undefined, card))
    }
  }
  return out
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
        startedAt: Date.now(),
      }
      const existing = idx >= 0 ? items[idx] : undefined
      if (existing) {
        const prev = existing.taskCard
        const merged: TaskCardState = {
          ...card,
          lastToolName: prev?.lastToolName,
          taskType: event.taskType ?? prev?.taskType,
          // 保留更早的 startedAt，避免 progress 重建冲掉
          startedAt: prev?.startedAt ?? card.startedAt,
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
          endedAt: Date.now(),
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
        endedAt: Date.now(),
      }
      return [...items, apply(undefined, card)]
    }
  }
}
