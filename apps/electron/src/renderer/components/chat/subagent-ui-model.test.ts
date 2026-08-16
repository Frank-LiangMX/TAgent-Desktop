/**
 * subagent-ui-model 单测
 *
 * 覆盖：委派积极性解析 / UI 配置、文本摘要、任务卡片状态机 reducer。
 * 纯函数，node 环境直接跑（对齐 vitest.config.ts environment: 'node'）。
 */
import { describe, expect, it } from 'vitest'
import type { TAgentMessage } from '@tagent/shared'
import {
  SUBAGENT_EAGERNESS_CONFIG,
  SUBAGENT_EAGERNESS_ORDER,
  resolveEagerness,
  extractFirstText,
  summarizeFirstText,
  formatProgressText,
  reduceTaskEvent,
  isSubagentRuntimeTaskType,
  canCreateSubagentTaskCard,
  rehydrateSubagentTaskCardsFromHistory,
  type TaskCardState,
  type TaskCardCarrier,
  type TaskCardEvent,
} from './subagent-ui-model'

// ===== 测试夹具 =====

/** 构造 assistant IR 消息（只含 text 块） */
function assistant(...texts: string[]): TAgentMessage {
  return {
    type: 'assistant',
    content: texts.map((t) => ({ type: 'text', text: t })),
  } as TAgentMessage
}

/** 新建一个递增 key 的卡片承载项 apply 工厂（隔离各测试计数） */
function mkFactory() {
  let n = 0
  return (existing: TaskCardCarrier | undefined, card: TaskCardState): TaskCardCarrier =>
    existing ? { ...existing, taskCard: card } : { key: `k${n++}`, taskCard: card }
}

// ===== 委派积极性 =====

describe('resolveEagerness', () => {
  it('缺省回退默认 balanced', () => {
    expect(resolveEagerness(undefined)).toBe('balanced')
  })

  it('meta 无字段回退默认 balanced', () => {
    expect(resolveEagerness({})).toBe('balanced')
  })

  it('meta 无字段时使用全局 fallback', () => {
    expect(resolveEagerness({}, 'aggressive')).toBe('aggressive')
    expect(resolveEagerness(undefined, 'never')).toBe('never')
  })

  it('会话档优先于全局 fallback', () => {
    expect(resolveEagerness({ subagentEagerness: 'balanced' }, 'aggressive')).toBe('balanced')
  })

  it('回显已持久化档位', () => {
    expect(resolveEagerness({ subagentEagerness: 'aggressive' })).toBe('aggressive')
    expect(resolveEagerness({ subagentEagerness: 'never' })).toBe('never')
  })

  it('非法值回退默认 balanced', () => {
    expect(resolveEagerness({ subagentEagerness: 'lunatic' as never })).toBe('balanced')
  })
})

describe('SUBAGENT_EAGERNESS config', () => {
  it('四个档位齐全且文案为中文', () => {
    expect(SUBAGENT_EAGERNESS_ORDER).toEqual(['never', 'conservative', 'balanced', 'aggressive'])
    for (const key of SUBAGENT_EAGERNESS_ORDER) {
      const cfg = SUBAGENT_EAGERNESS_CONFIG[key]
      expect(cfg.label.length).toBeGreaterThan(0)
      expect(cfg.description.length).toBeGreaterThan(0)
    }
  })
})

// ===== 文本摘要 =====

describe('extractFirstText / summarizeFirstText', () => {
  it('取首个 text 块', () => {
    expect(extractFirstText(assistant('hello', 'world'))).toBe('hello')
  })

  it('无 text 块返回 undefined', () => {
    expect(extractFirstText({ type: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] } as unknown as TAgentMessage)).toBeUndefined()
  })

  it('压空白并截断为一行摘要', () => {
    const msg = assistant('第一行\n第二行\n\n第三段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长')
    const summary = summarizeFirstText(msg, 20)
    expect(summary).toBe(summary.slice(0, 20))
    expect(summary).not.toContain('\n')
  })

  it('无文本摘要为空串', () => {
    expect(summarizeFirstText({ type: 'assistant', content: [] } as unknown as TAgentMessage)).toBe('')
  })
})

// ===== 进度文案 =====

describe('formatProgressText', () => {
  it('优先用 description', () => {
    expect(formatProgressText({ description: '正在搜索', lastToolName: 'Grep' })).toBe('正在搜索')
  })

  it('无 description 时用 lastToolName', () => {
    expect(formatProgressText({ lastToolName: 'Grep' })).toBe('运行工具：Grep')
  })

  it('都没有时返回 undefined', () => {
    expect(formatProgressText({})).toBeUndefined()
  })

  it('空白 description 不采用，回退 lastToolName', () => {
    expect(formatProgressText({ description: '   ', lastToolName: 'Read' })).toBe('运行工具：Read')
  })
})

// ===== 任务卡片状态机 =====

/** 真子代理 started（必须带 taskType，白名单） */
function agentStarted(
  partial: Omit<Extract<TaskCardEvent, { type: 'task_started' }>, 'type' | 'taskType'> & {
    taskType?: string
  },
): TaskCardEvent {
  return { type: 'task_started', taskType: 'local_agent', ...partial }
}

describe('isSubagentRuntimeTaskType / canCreateSubagentTaskCard', () => {
  it('白名单放行 local_agent / agent', () => {
    expect(isSubagentRuntimeTaskType('local_agent')).toBe(true)
    expect(isSubagentRuntimeTaskType('agent')).toBe(true)
    expect(canCreateSubagentTaskCard({ taskType: 'local_agent' })).toBe(true)
  })

  it('默认拒绝：缺省、local_bash、未知类型（不开黑名单洞）', () => {
    expect(isSubagentRuntimeTaskType(undefined)).toBe(false)
    expect(isSubagentRuntimeTaskType('local_bash')).toBe(false)
    expect(isSubagentRuntimeTaskType('local_shell')).toBe(false)
    expect(isSubagentRuntimeTaskType('something_else')).toBe(false)
    expect(canCreateSubagentTaskCard({ taskType: 'local_bash' })).toBe(false)
    expect(canCreateSubagentTaskCard({})).toBe(false)
  })
})

describe('reduceTaskEvent', () => {
  it('task_started 建一张 running 卡片', () => {
    const create = mkFactory()
    const items = reduceTaskEvent(
      [],
      agentStarted({ taskId: 't1', description: '探索代码库' }),
      create,
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.taskCard).toMatchObject({
      taskId: 't1',
      status: 'running',
      description: '探索代码库',
      progressText: '探索代码库',
      taskType: 'local_agent',
    })
  })

  it('local_bash task_started 不建卡（本机 Bash 不是子代理）', () => {
    const create = mkFactory()
    const items = reduceTaskEvent(
      [],
      {
        type: 'task_started',
        taskId: 'bash1',
        toolUseId: 'tu_bash',
        description: 'Check docs/plans naming conventions',
        taskType: 'local_bash',
      },
      create,
    )
    expect(items).toHaveLength(0)
  })

  it('缺省 taskType 的 task_started 不建卡（默认拒绝）', () => {
    const create = mkFactory()
    const items = reduceTaskEvent(
      [],
      { type: 'task_started', taskId: 't1', description: '探索代码库' },
      create,
    )
    expect(items).toHaveLength(0)
  })

  it('task_started 无 description 时进度文案为 启动中…', () => {
    const create = mkFactory()
    const items = reduceTaskEvent([], agentStarted({ taskId: 't1', description: '' }), create)
    expect(items[0]?.taskCard?.progressText).toBe('启动中…')
  })

  it('同 taskId 的 task_started 是 upsert，不新增卡片', () => {
    const create = mkFactory()
    let items = reduceTaskEvent([], agentStarted({ taskId: 't1', description: 'A' }), create)
    const firstKey = items[0]?.key
    items = reduceTaskEvent(items, agentStarted({ taskId: 't1', description: 'B' }), create)
    expect(items).toHaveLength(1)
    expect(items[0]?.key).toBe(firstKey) // 原地更新，key 不变
    expect(items[0]?.taskCard?.description).toBe('B')
  })

  it('task_progress 更新同一卡片进度文案，不新增气泡', () => {
    const create = mkFactory()
    let items = reduceTaskEvent([], agentStarted({ taskId: 't1', description: '探索' }), create)
    items = reduceTaskEvent(items, { type: 'task_progress', taskId: 't1', lastToolName: 'Grep' }, create)
    expect(items).toHaveLength(1) // 不新增
    const card0 = items[0]?.taskCard
    expect(card0?.lastToolName).toBe('Grep')
    expect(card0?.progressText).toBe('运行工具：Grep')
    expect(card0?.status).toBe('running')
  })

  it('task_progress 仅带 toolUseId 时按 toolUseId 回退匹配', () => {
    const create = mkFactory()
    let items = reduceTaskEvent(
      [],
      agentStarted({ taskId: 't1', toolUseId: 'tu1', description: '探索' }),
      create,
    )
    items = reduceTaskEvent(items, { type: 'task_progress', toolUseId: 'tu1', lastToolName: 'Read' }, create)
    expect(items).toHaveLength(1)
    expect(items[0]?.taskCard?.lastToolName).toBe('Read')
  })

  it('task_notification 收口：置 status + summary，清空进度文案', () => {
    const create = mkFactory()
    let items = reduceTaskEvent([], agentStarted({ taskId: 't1', description: '探索' }), create)
    items = reduceTaskEvent(items, { type: 'task_progress', taskId: 't1', lastToolName: 'Grep' }, create)
    items = reduceTaskEvent(
      items,
      { type: 'task_notification', taskId: 't1', status: 'completed', summary: '找到 3 个文件' },
      create,
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.taskCard?.status).toBe('completed')
    expect(items[0]?.taskCard?.summary).toBe('找到 3 个文件')
    expect(items[0]?.taskCard?.progressText).toBeUndefined()
  })

  it('task_progress 命中已收口卡片时不复活（status 不回 running）', () => {
    const create = mkFactory()
    let items = reduceTaskEvent([], agentStarted({ taskId: 't1', description: '探索' }), create)
    items = reduceTaskEvent(
      items,
      { type: 'task_notification', taskId: 't1', status: 'failed', summary: '失败' },
      create,
    )
    items = reduceTaskEvent(items, { type: 'task_progress', taskId: 't1', lastToolName: 'Grep' }, create)
    expect(items[0]?.taskCard?.status).toBe('failed')
    expect(items[0]?.taskCard?.progressText).toBeUndefined()
  })

  it('无卡时 task_notification 缺 taskType 不建卡；带 local_agent 才建', () => {
    const create = mkFactory()
    const denied = reduceTaskEvent(
      [],
      { type: 'task_notification', taskId: 't1', status: 'stopped', summary: '用户中止' },
      create,
    )
    expect(denied).toHaveLength(0)
    const allowed = reduceTaskEvent(
      [],
      {
        type: 'task_notification',
        taskId: 't1',
        status: 'stopped',
        summary: '用户中止',
        taskType: 'local_agent',
      },
      create,
    )
    expect(allowed).toHaveLength(1)
    expect(allowed[0]?.taskCard?.status).toBe('stopped')
  })

  it('无卡时 task_progress 缺 taskType 不建卡；带 local_agent 才建并保留到 started', () => {
    const create = mkFactory()
    const denied = reduceTaskEvent(
      [],
      { type: 'task_progress', taskId: 't1', lastToolName: 'Grep' },
      create,
    )
    expect(denied).toHaveLength(0)
    let items = reduceTaskEvent(
      [],
      { type: 'task_progress', taskId: 't1', lastToolName: 'Grep', taskType: 'local_agent' },
      create,
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.taskCard?.status).toBe('running')
    items = reduceTaskEvent(items, agentStarted({ taskId: 't1', description: '探索' }), create)
    expect(items).toHaveLength(1)
    expect(items[0]?.taskCard?.description).toBe('探索')
    expect(items[0]?.taskCard?.lastToolName).toBe('Grep')
  })

  it('多个不同 taskId 并存：各自独立生命周期', () => {
    const create = mkFactory()
    let items: TaskCardCarrier[] = []
    items = reduceTaskEvent(items, agentStarted({ taskId: 't1', description: '探索' }), create)
    items = reduceTaskEvent(items, agentStarted({ taskId: 't2', description: '审查' }), create)
    items = reduceTaskEvent(items, { type: 'task_progress', taskId: 't2', lastToolName: 'Read' }, create)
    items = reduceTaskEvent(
      items,
      { type: 'task_notification', taskId: 't1', status: 'completed', summary: 'OK' },
      create,
    )
    expect(items).toHaveLength(2)
    const t1 = items.find((i) => i.taskCard?.taskId === 't1')
    const t2 = items.find((i) => i.taskCard?.taskId === 't2')
    expect(t1?.taskCard?.status).toBe('completed')
    expect(t2?.taskCard?.status).toBe('running')
    expect(t2?.taskCard?.lastToolName).toBe('Read')
  })

  it('不修改原数组（返回新数组）', () => {
    const create = mkFactory()
    const items = reduceTaskEvent([], agentStarted({ taskId: 't1', description: 'A' }), create)
    const snapshot = [...items]
    reduceTaskEvent(items, { type: 'task_progress', taskId: 't1', lastToolName: 'Grep' }, create)
    expect(items).toEqual(snapshot) // 原数组未被 mutate
  })

  it('apply 决定承载项形状（就地更新保留额外字段，新建携带额外字段）', () => {
    interface RichItem extends TaskCardCarrier {
      kind: 'rich'
    }
    let n = 0
    const applyRich = (existing: RichItem | undefined, card: TaskCardState): RichItem =>
      existing ? { ...existing, taskCard: card } : { key: `r${n++}`, taskCard: card, kind: 'rich' }
    let items = reduceTaskEvent<RichItem>(
      [],
      agentStarted({ taskId: 't1', description: 'A' }),
      applyRich,
    )
    expect(items[0]?.kind).toBe('rich')
    expect(items[0]?.taskCard?.taskId).toBe('t1')
    // 进度更新就地保留 kind
    items = reduceTaskEvent(items, { type: 'task_progress', taskId: 't1', lastToolName: 'Grep' }, applyRich)
    expect(items[0]?.kind).toBe('rich')
    expect(items[0]?.taskCard?.lastToolName).toBe('Grep')
  })
})

describe('rehydrateSubagentTaskCardsFromHistory', () => {
  type HistItem = TaskCardCarrier & { message?: TAgentMessage }

  it('从 task tool_use + tool_result 回填 completed 卡与结论摘要', () => {
    const create = mkFactory()
    const items: HistItem[] = [
      {
        key: 'a1',
        message: {
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'task',
              input: { description: '探索项目', subagent_type: 'explorer', prompt: 'go' },
            },
          ],
        } as TAgentMessage,
      },
      {
        key: 'u1',
        message: {
          type: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'call_1',
              content: '这是子代理的完整结论报告，包含目录结构。',
            },
          ],
        } as TAgentMessage,
      },
    ]
    const out = rehydrateSubagentTaskCardsFromHistory(items, create)
    const card = out.find((i) => i.taskCard?.toolUseId === 'call_1')?.taskCard
    expect(card).toBeDefined()
    expect(card?.status).toBe('completed')
    expect(card?.description).toContain('探索项目')
    expect(card?.summary).toContain('完整结论报告')
  })

  it('无 tool_result 时 status=stopped，summary 标明无结论', () => {
    const create = mkFactory()
    const items: HistItem[] = [
      {
        key: 'a1',
        message: {
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_x',
              name: 'task',
              input: { description: '半路中断' },
            },
          ],
        } as TAgentMessage,
      },
    ]
    const out = rehydrateSubagentTaskCardsFromHistory(items, create)
    const card = out.find((i) => i.taskCard?.toolUseId === 'call_x')?.taskCard
    expect(card?.status).toBe('stopped')
    expect(card?.summary).toContain('无回传结论')
  })
})
