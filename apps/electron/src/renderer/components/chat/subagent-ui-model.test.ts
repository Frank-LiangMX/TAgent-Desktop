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
  it('缺省回退默认 conservative', () => {
    expect(resolveEagerness(undefined)).toBe('conservative')
  })

  it('meta 无字段回退默认 conservative', () => {
    expect(resolveEagerness({})).toBe('conservative')
  })

  it('回显已持久化档位', () => {
    expect(resolveEagerness({ subagentEagerness: 'aggressive' })).toBe('aggressive')
    expect(resolveEagerness({ subagentEagerness: 'never' })).toBe('never')
  })

  it('非法值回退默认 conservative', () => {
    expect(resolveEagerness({ subagentEagerness: 'lunatic' as never })).toBe('conservative')
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

describe('reduceTaskEvent', () => {
  it('task_started 建一张 running 卡片', () => {
    const create = mkFactory()
    const items = reduceTaskEvent([], { type: 'task_started', taskId: 't1', description: '探索代码库' }, create)
    expect(items).toHaveLength(1)
    expect(items[0]?.taskCard).toMatchObject({
      taskId: 't1',
      status: 'running',
      description: '探索代码库',
      progressText: '探索代码库',
    })
  })

  it('task_started 无 description 时进度文案为 启动中…', () => {
    const create = mkFactory()
    const items = reduceTaskEvent([], { type: 'task_started', taskId: 't1', description: '' }, create)
    expect(items[0]?.taskCard?.progressText).toBe('启动中…')
  })

  it('同 taskId 的 task_started 是 upsert，不新增卡片', () => {
    const create = mkFactory()
    let items = reduceTaskEvent([], { type: 'task_started', taskId: 't1', description: 'A' }, create)
    const firstKey = items[0]?.key
    items = reduceTaskEvent(items, { type: 'task_started', taskId: 't1', description: 'B' }, create)
    expect(items).toHaveLength(1)
    expect(items[0]?.key).toBe(firstKey) // 原地更新，key 不变
    expect(items[0]?.taskCard?.description).toBe('B')
  })

  it('task_progress 更新同一卡片进度文案，不新增气泡', () => {
    const create = mkFactory()
    let items = reduceTaskEvent([], { type: 'task_started', taskId: 't1', description: '探索' }, create)
    items = reduceTaskEvent(items, { type: 'task_progress', taskId: 't1', lastToolName: 'Grep' }, create)
    expect(items).toHaveLength(1) // 不新增
    const card0 = items[0]?.taskCard
    expect(card0?.lastToolName).toBe('Grep')
    expect(card0?.progressText).toBe('运行工具：Grep')
    expect(card0?.status).toBe('running')
  })

  it('task_progress 仅带 toolUseId 时按 toolUseId 回退匹配', () => {
    const create = mkFactory()
    let items = reduceTaskEvent([], { type: 'task_started', taskId: 't1', toolUseId: 'tu1', description: '探索' }, create)
    items = reduceTaskEvent(items, { type: 'task_progress', toolUseId: 'tu1', lastToolName: 'Read' }, create)
    expect(items).toHaveLength(1)
    expect(items[0]?.taskCard?.lastToolName).toBe('Read')
  })

  it('task_notification 收口：置 status + summary，清空进度文案', () => {
    const create = mkFactory()
    let items = reduceTaskEvent([], { type: 'task_started', taskId: 't1', description: '探索' }, create)
    items = reduceTaskEvent(items, { type: 'task_progress', taskId: 't1', lastToolName: 'Grep' }, create)
    items = reduceTaskEvent(items, { type: 'task_notification', taskId: 't1', status: 'completed', summary: '找到 3 个文件' }, create)
    expect(items).toHaveLength(1)
    expect(items[0]?.taskCard?.status).toBe('completed')
    expect(items[0]?.taskCard?.summary).toBe('找到 3 个文件')
    expect(items[0]?.taskCard?.progressText).toBeUndefined()
  })

  it('task_progress 命中已收口卡片时不复活（status 不回 running）', () => {
    const create = mkFactory()
    let items = reduceTaskEvent([], { type: 'task_started', taskId: 't1', description: '探索' }, create)
    items = reduceTaskEvent(items, { type: 'task_notification', taskId: 't1', status: 'failed', summary: '失败' }, create)
    items = reduceTaskEvent(items, { type: 'task_progress', taskId: 't1', lastToolName: 'Grep' }, create)
    expect(items[0]?.taskCard?.status).toBe('failed')
    expect(items[0]?.taskCard?.progressText).toBeUndefined()
  })

  it('task_notification 在无卡片时直接建一张已收口卡片', () => {
    const create = mkFactory()
    const items = reduceTaskEvent([], { type: 'task_notification', taskId: 't1', status: 'stopped', summary: '用户中止' }, create)
    expect(items).toHaveLength(1)
    expect(items[0]?.taskCard?.status).toBe('stopped')
    expect(items[0]?.taskCard?.summary).toBe('用户中止')
  })

  it('task_progress 早于 started 到达时建 running 卡片承载进度', () => {
    const create = mkFactory()
    let items = reduceTaskEvent([], { type: 'task_progress', taskId: 't1', lastToolName: 'Grep' }, create)
    expect(items).toHaveLength(1)
    expect(items[0]?.taskCard?.status).toBe('running')
    // 随后 started 到达：upsert 同一张卡片，保留 lastToolName
    items = reduceTaskEvent(items, { type: 'task_started', taskId: 't1', description: '探索' }, create)
    expect(items).toHaveLength(1)
    expect(items[0]?.taskCard?.description).toBe('探索')
    expect(items[0]?.taskCard?.lastToolName).toBe('Grep')
  })

  it('多个不同 taskId 并存：各自独立生命周期', () => {
    const create = mkFactory()
    let items: TaskCardCarrier[] = []
    items = reduceTaskEvent(items, { type: 'task_started', taskId: 't1', description: '探索' }, create)
    items = reduceTaskEvent(items, { type: 'task_started', taskId: 't2', description: '审查' }, create)
    items = reduceTaskEvent(items, { type: 'task_progress', taskId: 't2', lastToolName: 'Read' }, create)
    items = reduceTaskEvent(items, { type: 'task_notification', taskId: 't1', status: 'completed', summary: 'OK' }, create)
    expect(items).toHaveLength(2)
    const t1 = items.find((i) => i.taskCard?.taskId === 't1')
    const t2 = items.find((i) => i.taskCard?.taskId === 't2')
    expect(t1?.taskCard?.status).toBe('completed')
    expect(t2?.taskCard?.status).toBe('running')
    expect(t2?.taskCard?.lastToolName).toBe('Read')
  })

  it('不修改原数组（返回新数组）', () => {
    const create = mkFactory()
    const items = reduceTaskEvent([], { type: 'task_started', taskId: 't1', description: 'A' }, create)
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
      { type: 'task_started', taskId: 't1', description: 'A' } as TaskCardEvent,
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
