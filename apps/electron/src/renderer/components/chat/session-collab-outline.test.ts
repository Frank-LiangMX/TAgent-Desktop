import { describe, expect, test } from 'vitest'
import type { MoADiscussionPanel, MoARoundtablePanel, TAgentMessage } from '@tagent/shared'
import {
  collectSessionCollabOutline,
  crewBoardToCollabItem,
  groupCollabItems,
  mergeCrewIntoOutline,
  runningCollabItems,
  type CollabSourceItem,
} from './session-collab-outline'

const consult = (over: Partial<MoARoundtablePanel> = {}): MoARoundtablePanel => ({
  kind: 'moa_roundtable',
  roundtableId: 'rt-1',
  presetId: 'p-arch',
  presetName: '架构会诊',
  topic: '评审登录方案',
  seats: [
    { seatId: 'a', name: '架构', modelId: 'glm', role: 'reference', status: 'ok' },
    { seatId: 'b', name: '安全', modelId: 'kimi', role: 'reference', status: 'running' },
    { seatId: 'agg', name: '汇总', modelId: 'glm', role: 'aggregator', status: 'pending' },
  ],
  phase: 'references',
  ...over,
})

const discussion = (over: Partial<MoADiscussionPanel> = {}): MoADiscussionPanel => ({
  kind: 'moa_discussion',
  discussionId: 'd-1',
  presetName: '方案研讨',
  topic: '收敛鉴权方案',
  speakers: [
    { speakerId: 's1', name: '产品', modelId: 'glm', role: 'participant' },
    { speakerId: 's2', name: '研发', modelId: 'kimi', role: 'participant' },
    { speakerId: 'mod', name: '总结人', modelId: 'glm', role: 'moderator' },
  ],
  entries: [
    { entryId: 'e1', speakerId: 's1', text: '先定边界', turn: 1, createdAt: 1_700_000_000_000 },
  ],
  phase: 'discussing',
  roundLimit: 6,
  currentRound: 2,
  ...over,
})

const assistantLauncher = (id: string, prompt: string): TAgentMessage => ({
  type: 'assistant',
  modelId: 'glm',
  content: [{ type: 'tool_use', id, name: 'Agent', input: { description: prompt } }],
})

describe('collectSessionCollabOutline', () => {
  test('empty items → empty outline', () => {
    const out = collectSessionCollabOutline([])
    expect(out.items).toEqual([])
    expect(out.runningCount).toBe(0)
    expect(out.counts).toEqual({ consult: 0, discussion: 0, crew: 0, subagent: 0 })
  })

  test('indexes consult + discussion in timeline order', () => {
    const items: CollabSourceItem[] = [
      { key: 'moa-rt-1', moaRoundtable: consult() },
      { key: 'disc-d-1', moaDiscussion: discussion() },
    ]
    const out = collectSessionCollabOutline(items)
    expect(out.items.map((i) => i.kind)).toEqual(['consult', 'discussion'])
    expect(out.counts.consult).toBe(1)
    expect(out.counts.discussion).toBe(1)
    expect(out.runningCount).toBe(2)
    expect(out.items[0]?.title).toBe('评审登录方案')
    expect(out.items[0]?.statusLabel).toBe('交卷中')
    expect(out.items[0]?.subtitle).toContain('1/2 席')
    expect(out.items[1]?.title).toBe('收敛鉴权方案')
    expect(out.items[1]?.subtitle).toContain('第 2/6 轮')
    expect(out.items[1]?.discussionId).toBe('d-1')
  })

  test('dedupes same consult/discussion id', () => {
    const items: CollabSourceItem[] = [
      { key: 'moa-rt-1', moaRoundtable: consult() },
      { key: 'moa-rt-1b', moaRoundtable: consult({ phase: 'done' }) },
      { key: 'disc-d-1', moaDiscussion: discussion() },
      { key: 'disc-d-1b', moaDiscussion: discussion({ phase: 'done' }) },
    ]
    const out = collectSessionCollabOutline(items)
    expect(out.counts.consult).toBe(1)
    expect(out.counts.discussion).toBe(1)
    expect(out.items[0]?.status).toBe('running')
  })

  test('maps terminal phases', () => {
    const items: CollabSourceItem[] = [
      { key: 'a', moaRoundtable: consult({ phase: 'done', roundtableId: 'done' }) },
      { key: 'b', moaRoundtable: consult({ phase: 'error', roundtableId: 'err' }) },
      { key: 'c', moaDiscussion: discussion({ phase: 'cancelled', discussionId: 'cx' }) },
    ]
    const out = collectSessionCollabOutline(items)
    expect(out.items.map((i) => i.status)).toEqual(['done', 'error', 'cancelled'])
    expect(out.runningCount).toBe(0)
  })

  test('indexes subagent launchers and prefers taskCard title/status', () => {
    const items: CollabSourceItem[] = [
      { key: 'h1', message: assistantLauncher('tu-1', '探索仓库结构') },
      {
        key: 'task1',
        taskCard: {
          taskId: 't1',
          toolUseId: 'tu-1',
          taskType: 'local_agent',
          description: '探索仓库结构',
          status: 'completed',
          summary: '已列出 apps/ 与 packages/',
        },
      },
    ]
    const out = collectSessionCollabOutline(items)
    expect(out.counts.subagent).toBe(1)
    expect(out.items[0]?.kind).toBe('subagent')
    expect(out.items[0]?.title).toBe('探索仓库结构')
    expect(out.items[0]?.status).toBe('done')
    expect(out.items[0]?.parentToolUseId).toBe('tu-1')
    expect(out.items[0]?.subtitle).toContain('apps/')
  })

  test('does not treat local_bash taskCard as subagent by itself', () => {
    const items: CollabSourceItem[] = [
      {
        key: 'bash',
        taskCard: {
          taskId: 'b1',
          toolUseId: 'bash-1',
          taskType: 'local_bash',
          description: '跑测试',
          status: 'running',
        },
      },
    ]
    const out = collectSessionCollabOutline(items)
    expect(out.counts.subagent).toBe(0)
    expect(out.items).toEqual([])
  })

  test('falls back to preset name when topic is blank', () => {
    const out = collectSessionCollabOutline([
      { key: 'moa-x', moaRoundtable: consult({ topic: '   ', presetName: '默认班底' }) },
    ])
    expect(out.items[0]?.title).toBe('默认班底')
  })

  test('indexes 班组完成 notice from timeline, not a default panel entry', () => {
    const items: CollabSourceItem[] = [
      {
        key: 'crew-1',
        message: {
          type: 'assistant',
          modelId: '班组通知',
          content: [
            {
              type: 'text',
              text: '【班组完成】实现登录\n合计 4 项：完成 3，失败 1。',
            },
          ],
        },
      },
    ]
    const out = collectSessionCollabOutline(items)
    expect(out.counts.crew).toBe(1)
    expect(out.items[0]?.kind).toBe('crew')
    expect(out.items[0]?.title).toBe('实现登录')
    expect(out.items[0]?.status).toBe('error')
    expect(out.items[0]?.anchorKey).toBe('crew-1')
  })

  test('session without nested collab stays empty', () => {
    const out = collectSessionCollabOutline([
      {
        key: 'h1',
        message: { type: 'user', content: [{ type: 'text', text: '你好' }] },
      },
    ])
    expect(out.items).toEqual([])
    expect(out.counts.crew).toBe(0)
  })
})

describe('crew + group', () => {
  test('crewBoardToCollabItem derives running / done / failed', () => {
    const running = crewBoardToCollabItem({
      id: 'b1',
      title: '实现登录',
      status: 'active',
      running: 2,
      ready: 1,
      pending: 0,
      done: 1,
      failed: 0,
      total: 4,
    })
    expect(running.status).toBe('running')
    expect(running.statusLabel).toBe('执行中')
    expect(running.subtitle).toContain('1/4 完成')
    expect(running.subtitle).toContain('2 执行中')

    const failed = crewBoardToCollabItem({
      id: 'b2',
      rootGoal: '修安装包',
      status: 'active',
      running: 0,
      done: 1,
      failed: 1,
      total: 2,
    })
    expect(failed.status).toBe('error')
    expect(failed.title).toBe('修安装包')

    const done = crewBoardToCollabItem({
      id: 'b3',
      title: '收工板',
      status: 'completed',
      done: 3,
      total: 3,
    })
    expect(done.status).toBe('done')
  })

  test('mergeCrewIntoOutline appends crew and recounts running', () => {
    const base = collectSessionCollabOutline([
      { key: 'moa-rt-1', moaRoundtable: consult({ phase: 'done' }) },
    ])
    const merged = mergeCrewIntoOutline(base, [
      { id: 'b1', title: '实现登录', status: 'active', running: 1, total: 3, done: 1 },
    ])
    expect(merged.counts.crew).toBe(1)
    expect(merged.counts.consult).toBe(1)
    expect(merged.runningCount).toBe(1)
    expect(merged.items.some((i) => i.kind === 'crew' && i.boardId === 'b1')).toBe(true)
  })

  test('groupCollabItems respects filter and kind order', () => {
    const items = collectSessionCollabOutline([
      { key: 'h1', message: assistantLauncher('tu-1', '探索') },
      { key: 'moa-rt-1', moaRoundtable: consult() },
      { key: 'disc-d-1', moaDiscussion: discussion() },
    ]).items
    const all = groupCollabItems(items)
    expect(all.map((g) => g.kind)).toEqual(['consult', 'discussion', 'subagent'])
    const onlyDisc = groupCollabItems(items, 'discussion')
    expect(onlyDisc).toHaveLength(1)
    expect(onlyDisc[0]?.items).toHaveLength(1)
    expect(runningCollabItems(items).every((i) => i.status === 'running')).toBe(true)
  })
})
