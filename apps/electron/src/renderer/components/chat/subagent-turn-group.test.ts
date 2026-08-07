/**
 * groupSubagentItems 单测（Vitest）
 *
 * 覆盖：同一子代理（同一 parentToolUseId）的多条消息合并分组、保序、
 * 主消息不进入分组、无子代理时返回空数组。
 * 纯函数，node 环境直接跑。
 */
import { describe, expect, it } from 'vitest'
import type { TAgentMessage } from '@tagent/shared'
import {
  buildTurnPresentation,
  filterSubagentItems,
  findSubagentTaskTool,
  groupItemsIntoTurns,
  groupSubagentItems,
  isRealUserInput,
  isSubagentLauncherTool,
  listSubagentEntryIds,
  type TurnSourceItem,
} from './session-turn-model'

/** 构造带 parentToolUseId 的 assistant 消息 */
function subagentMessage(parentToolUseId: string, text: string, key: string): TurnSourceItem {
  return {
    key,
    message: {
      type: 'assistant',
      parentToolUseId,
      content: [{ type: 'text', text }],
    } as TAgentMessage,
  }
}

/** 构造主线 assistant 消息（无 parentToolUseId） */
function mainMessage(text: string, key: string): TurnSourceItem {
  return {
    key,
    message: {
      type: 'assistant',
      content: [{ type: 'text', text }],
    } as TAgentMessage,
  }
}

describe('groupSubagentItems', () => {
  it('returns empty array when no subagent messages', () => {
    const items = [mainMessage('主线', 'm1'), mainMessage('主线2', 'm2')]
    expect(groupSubagentItems(items)).toEqual([])
  })

  it('groups messages of the same subagent by parentToolUseId preserving order', () => {
    const items: TurnSourceItem[] = [
      mainMessage('主线', 'm1'),
      subagentMessage('task-1', '思考步骤1', 's1'),
      subagentMessage('task-1', '工具步骤2', 's2'),
      mainMessage('主线2', 'm2'),
      subagentMessage('task-2', '另一个子代理', 's3'),
      subagentMessage('task-1', '收尾', 's4'),
    ]
    const groups = groupSubagentItems(items)
    expect(groups).toHaveLength(2)
    // 组内保序：task-1 的 s1/s2/s4 顺序不变
    expect(groups[0]!.map((it) => it.key)).toEqual(['s1', 's2', 's4'])
    expect(groups[1]!.map((it) => it.key)).toEqual(['s3'])
  })

  it('does not include main messages into groups', () => {
    const items: TurnSourceItem[] = [
      mainMessage('主线', 'm1'),
      subagentMessage('task-1', '步骤', 's1'),
    ]
    const groups = groupSubagentItems(items)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.every((it) => it.message?.type === 'assistant' && it.message.parentToolUseId)).toBe(true)
  })
})

describe('isRealUserInput', () => {
  it('returns false for subagent delegation messages (text + parentToolUseId)', () => {
    const msg: TAgentMessage = {
      type: 'user',
      parentToolUseId: 'call_123',
      content: [{ type: 'text', text: 'Explore the project structure…' }],
    }
    expect(isRealUserInput(msg as Extract<TAgentMessage, { type: 'user' }>)).toBe(false)
  })

  it('returns true for genuine user input without parentToolUseId', () => {
    const msg: TAgentMessage = {
      type: 'user',
      content: [{ type: 'text', text: '分析一下项目' }],
    }
    expect(isRealUserInput(msg as Extract<TAgentMessage, { type: 'user' }>)).toBe(true)
  })
})

describe('groupItemsIntoTurns delegation messages', () => {
  it('merges subagent delegation user messages into assistant-turn, not user bubbles', () => {
    const delegation: TurnSourceItem = {
      key: 'd1',
      message: {
        type: 'user',
        parentToolUseId: 'call_123',
        content: [{ type: 'text', text: 'Explore the project structure…' }],
      } as TAgentMessage,
    }
    const realUser: TurnSourceItem = {
      key: 'u1',
      message: {
        type: 'user',
        content: [{ type: 'text', text: '分析一下项目' }],
      } as TAgentMessage,
    }
    const subagentReply: TurnSourceItem = {
      key: 's1',
      message: {
        type: 'assistant',
        parentToolUseId: 'call_123',
        content: [{ type: 'text', text: '项目结构分析如下…' }],
      } as TAgentMessage,
    }
    const items = [realUser, delegation, subagentReply]
    const turns = groupItemsIntoTurns(items)
    // 真实用户输入仍是 user turn
    expect(turns[0]?.kind).toBe('user')
    // 委派消息不产生新的 user turn
    expect(turns.filter((t) => t.kind === 'user')).toHaveLength(1)
    // 委派消息并入 assistant-turn
    const assistantTurns = turns.filter((t) => t.kind === 'assistant-turn')
    expect(assistantTurns).toHaveLength(1)
    if (assistantTurns[0]?.kind === 'assistant-turn') {
      expect(assistantTurns[0].items.map((it) => it.key)).toEqual(['d1', 's1'])
    }
  })
})

describe('filterSubagentItems', () => {
  it('returns only messages belonging to the given subagent (assistant + tool_result)', () => {
    const items: TurnSourceItem[] = [
      mainMessage('主线', 'm1'),
      subagentMessage('task-1', '思考', 's1'),
      {
        key: 'sr1',
        message: {
          type: 'user',
          parentToolUseId: 'task-1',
          content: [{ type: 'tool_result', toolUseId: 'tool-x', content: 'ok' }],
        } as TAgentMessage,
      },
      subagentMessage('task-2', '另一个', 's2'),
    ]
    const filtered = filterSubagentItems(items, 'task-1')
    expect(filtered.map((it) => it.key)).toEqual(['s1', 'sr1'])
  })

  it('returns empty when subagent has no messages', () => {
    const items = [mainMessage('主线', 'm1')]
    expect(filterSubagentItems(items, 'task-nope')).toEqual([])
  })
})

describe('findSubagentTaskTool', () => {
  it('finds the mainline task tool_use that launched the subagent', () => {
    const launcher: TurnSourceItem = {
      key: 'm1',
      message: {
        type: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'task-1',
            name: 'task',
            input: { description: '代码审查', prompt: '请审查变更' },
          },
        ],
      } as TAgentMessage,
    }
    const items: TurnSourceItem[] = [
      launcher,
      subagentMessage('task-1', '步骤', 's1'),
    ]
    const tool = findSubagentTaskTool(items, 'task-1')
    expect(tool).not.toBeNull()
    expect(tool?.name).toBe('task')
    expect(tool?.input).toEqual({ description: '代码审查', prompt: '请审查变更' })
  })

  it('finds Agent launcher by id', () => {
    const launcher: TurnSourceItem = {
      key: 'm1',
      message: {
        type: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_agent1',
            name: 'Agent',
            input: { description: '探索 electron' },
          },
        ],
      } as TAgentMessage,
    }
    expect(findSubagentTaskTool([launcher], 'call_agent1')?.name).toBe('Agent')
  })

  it('ignores subagent messages and returns null when no matching launcher', () => {
    const items: TurnSourceItem[] = [subagentMessage('task-1', '步骤', 's1')]
    expect(findSubagentTaskTool(items, 'task-1')).toBeNull()
  })
})

describe('isSubagentLauncherTool / listSubagentEntryIds', () => {
  it('recognizes Agent and task names', () => {
    expect(isSubagentLauncherTool('Agent')).toBe(true)
    expect(isSubagentLauncherTool('task')).toBe(true)
    expect(isSubagentLauncherTool('Task')).toBe(true)
    expect(isSubagentLauncherTool('Read')).toBe(false)
  })

  it('lists entry ids from launcher even before parented messages', () => {
    const items: TurnSourceItem[] = [
      {
        key: 'm1',
        message: {
          type: 'assistant',
          modelId: 'glm-5.2',
          content: [
            {
              type: 'tool_use',
              id: 'call_a',
              name: 'Agent',
              input: { description: '探索 A' },
            },
          ],
        } as TAgentMessage,
      },
    ]
    expect(listSubagentEntryIds(items)).toEqual(['call_a'])
  })

  it('dedupes launcher id and parented messages', () => {
    const items: TurnSourceItem[] = [
      {
        key: 'm1',
        message: {
          type: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'Agent', input: {} },
          ],
        } as TAgentMessage,
      },
      subagentMessage('call_a', '步骤', 's1'),
      subagentMessage('call_b', '无 launcher 兜底', 's2'),
    ]
    expect(listSubagentEntryIds(items)).toEqual(['call_a', 'call_b'])
  })

  it('ignores Bash tool_use with same id (not a launcher)', () => {
    const items: TurnSourceItem[] = [
      {
        key: 'm1',
        message: {
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_bash',
              name: 'Bash',
              input: { description: 'Check docs/plans naming conventions' },
            },
          ],
        } as TAgentMessage,
      },
    ]
    expect(findSubagentTaskTool(items, 'call_bash')).toBeNull()
    expect(listSubagentEntryIds(items)).toEqual([])
  })

  it('ignores taskCard without agent taskType (local_bash 冒充)', () => {
    const items: TurnSourceItem[] = [
      {
        key: 'task1',
        taskCard: {
          taskId: 't1',
          toolUseId: 'call_bash',
          status: 'failed',
          description: 'Check docs/plans naming conventions',
          taskType: 'local_bash',
        },
      },
    ]
    expect(listSubagentEntryIds(items)).toEqual([])
  })

  it('lists taskCard when taskType is local_agent', () => {
    const items: TurnSourceItem[] = [
      {
        key: 'task1',
        taskCard: {
          taskId: 't1',
          toolUseId: 'call_a',
          status: 'running',
          description: '探索',
          taskType: 'local_agent',
        },
      },
    ]
    expect(listSubagentEntryIds(items)).toEqual(['call_a'])
  })
})

describe('taskCard does not split assistant-turn / model badges', () => {
  it('merges taskCard into current assistant-turn instead of standalone', () => {
    const items: TurnSourceItem[] = [
      mainMessage('主线开始', 'm1'),
      {
        key: 'task1',
        taskCard: { taskId: 't1', toolUseId: 'call_a', status: 'running', description: '探索' },
      },
      subagentMessage('call_a', '子代理步骤', 's1'),
      mainMessage('主线收尾', 'm2'),
    ]
    const turns = groupItemsIntoTurns(items)
    expect(turns.filter((t) => t.kind === 'standalone')).toHaveLength(0)
    expect(turns.filter((t) => t.kind === 'assistant-turn')).toHaveLength(1)
    if (turns[0]?.kind === 'assistant-turn') {
      expect(turns[0].items.map((it) => it.key)).toEqual(['m1', 'task1', 's1', 'm2'])
      // 铭牌不取子代理 modelId
      expect(turns[0].modelId).toBeUndefined()
    }
  })

  it('mainline modelId is kept when present; subagent model ignored', () => {
    const items: TurnSourceItem[] = [
      {
        key: 'm1',
        message: {
          type: 'assistant',
          modelId: 'main-model',
          content: [{ type: 'text', text: 'hi' }],
        } as TAgentMessage,
      },
      {
        key: 's1',
        message: {
          type: 'assistant',
          modelId: 'sub-model',
          parentToolUseId: 'call_a',
          content: [{ type: 'text', text: 'sub' }],
        } as TAgentMessage,
      },
    ]
    const turns = groupItemsIntoTurns(items)
    expect(turns).toHaveLength(1)
    if (turns[0]?.kind === 'assistant-turn') {
      expect(turns[0].modelId).toBe('main-model')
    }
  })
})

describe('buildTurnPresentation excludes Agent launcher from process', () => {
  it('does not put Agent tool_use into process entries', () => {
    const turn = {
      kind: 'assistant-turn' as const,
      key: 'turn-1',
      isStreaming: false,
      modelId: 'glm-5.2',
      items: [
        {
          key: 'm1',
          message: {
            type: 'assistant',
            modelId: 'glm-5.2',
            content: [
              { type: 'text', text: '先委派' },
              {
                type: 'tool_use',
                id: 'call_a',
                name: 'Agent',
                input: { description: '探索' },
              },
              { type: 'tool_use', id: 'read_1', name: 'Read', input: { path: 'a.ts' } },
            ],
          } as TAgentMessage,
        },
        subagentMessage('call_a', '子代理正文不应进 process', 's1'),
      ],
    }
    const pres = buildTurnPresentation(turn)
    const toolNames = pres.process
      .filter((e) => e.type === 'tool')
      .map((e) => (e.type === 'tool' ? e.tool.name : ''))
    expect(toolNames).toEqual(['Read'])
    expect(toolNames).not.toContain('Agent')
    expect(pres.modelId).toBe('glm-5.2')
  })
})
