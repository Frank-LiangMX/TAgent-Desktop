import { describe, expect, it } from 'vitest'
import type { ProcessEntry } from './session-turn-model'
import {
  buildConciseTimeline,
  classifyToolFamily,
  isDeliverableThinking,
  isTrivialThinking,
  summarizeToolCluster,
} from './concise-timeline-model'

function tool(
  name: string,
  id: string,
  input: Record<string, unknown> = {},
  done = true,
): ProcessEntry {
  return {
    type: 'tool',
    key: id,
    tool: { type: 'tool_use', id, name, input },
    result: done
      ? { type: 'tool_result', toolUseId: id, content: 'ok', isError: false }
      : undefined,
  }
}

describe('classifyToolFamily', () => {
  it('maps explore/edit/shell', () => {
    expect(classifyToolFamily('Read')).toBe('explore')
    expect(classifyToolFamily('Grep')).toBe('explore')
    expect(classifyToolFamily('Edit')).toBe('edit')
    expect(classifyToolFamily('Write')).toBe('edit')
    expect(classifyToolFamily('Bash')).toBe('shell')
    expect(classifyToolFamily('Task')).toBe('other')
  })
})

describe('isDeliverableThinking / isTrivialThinking', () => {
  it('treats bold markdown as deliverable', () => {
    expect(
      isDeliverableThinking(
        'Proma 我看了结构——它不是外围扩展，而是拿 **pi / Claude Agent SDK** 当内核。',
      ),
    ).toBe(true)
  })

  it('treats short meta as trivial', () => {
    expect(isTrivialThinking('让我先看看目录结构')).toBe(true)
    expect(isTrivialThinking('接下来读几个关键文件')).toBe(true)
  })
})

describe('buildConciseTimeline', () => {
  it('merges consecutive Reads into one explore cluster', () => {
    const process: ProcessEntry[] = [
      tool('Read', '1', { file_path: 'a.ts' }),
      tool('Read', '2', { file_path: 'b.ts' }),
      tool('Grep', '3', { pattern: 'x' }),
    ]
    const segs = buildConciseTimeline(process)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'tool_cluster', family: 'explore' })
    if (segs[0]!.kind === 'tool_cluster') {
      expect(segs[0].tools).toHaveLength(3)
    }
  })

  it('splits clusters when narrative text appears between tools', () => {
    const process: ProcessEntry[] = [
      tool('Read', '1', { file_path: 'a.ts' }),
      tool('Read', '2', { file_path: 'b.ts' }),
      { type: 'text', key: 'n1', text: '先看这两个文件。' },
      tool('Edit', '3', { file_path: 'a.ts' }),
    ]
    const segs = buildConciseTimeline(process)
    expect(segs.map((s) => s.kind)).toEqual([
      'tool_cluster',
      'narrative',
      'tool_cluster',
    ])
  })

  it('hides trivial inter-tool thinking and keeps one leading fold', () => {
    const process: ProcessEntry[] = [
      { type: 'thinking', key: 't1', thinking: '先看目录结构再决定' },
      tool('Bash', 'b1', { command: 'dir' }),
      { type: 'thinking', key: 't2', thinking: '让我再读两个文件' },
      tool('Read', 'r1', { file_path: 'a.ts' }),
      tool('Read', 'r2', { file_path: 'b.ts' }),
      { type: 'thinking', key: 't3', thinking: '接下来跑 git' },
      tool('Bash', 'b2', { command: 'git status' }),
    ]
    const segs = buildConciseTimeline(process)
    const thinks = segs.filter((s) => s.kind === 'thinking')
    expect(thinks).toHaveLength(1)
    expect(segs.filter((s) => s.kind === 'narrative')).toHaveLength(0)
    expect(segs.map((s) => s.kind)).toEqual([
      'thinking',
      'tool_cluster',
      'tool_cluster',
      'tool_cluster',
    ])
  })

  it('lifts bold post-tool thinking out of the fold into narrative', () => {
    const process: ProcessEntry[] = [
      { type: 'thinking', key: 't1', thinking: '先摸清 Proma 结构' },
      tool('Bash', 'b1', { command: 'dir' }),
      tool('Read', 'r1', { file_path: 'package.json' }),
      {
        type: 'thinking',
        key: 't2',
        thinking:
          'Proma 我看了结构——它不是「外围扩展」式的改造，而是拿 **pi / Claude Agent SDK** 当内核，改造深度明显更激进。',
      },
    ]
    const segs = buildConciseTimeline(process)
    expect(segs.map((s) => s.kind)).toEqual([
      'thinking',
      'tool_cluster',
      'tool_cluster',
      'narrative',
    ])
    const narr = segs.find((s) => s.kind === 'narrative')
    expect(narr && narr.kind === 'narrative' ? narr.text : '').toContain('**pi / Claude Agent SDK**')
    // 加粗结论不得留在思考折叠里
    const think = segs.find((s) => s.kind === 'thinking')
    expect(think && think.kind === 'thinking' ? think.thinking : '').not.toContain('**pi')
  })

  it('merges same-family tools across trivial thinking gaps', () => {
    const process: ProcessEntry[] = [
      tool('Read', '1', { file_path: 'a.ts' }),
      { type: 'thinking', key: 't', thinking: '继续读' },
      tool('Read', '2', { file_path: 'b.ts' }),
      tool('Grep', '3', { pattern: 'x' }),
    ]
    const segs = buildConciseTimeline(process)
    expect(segs.map((s) => s.kind)).toEqual(['tool_cluster'])
    if (segs[0]!.kind === 'tool_cluster') {
      expect(segs[0].tools).toHaveLength(3)
    }
  })

  it('narrative text splits phases', () => {
    const process: ProcessEntry[] = [
      { type: 'thinking', key: 't1', thinking: '阶段一思考内容略长一点' },
      tool('Read', '1', { file_path: 'a.ts' }),
      { type: 'text', key: 'n1', text: '先看这两个文件。' },
      { type: 'thinking', key: 't2', thinking: '阶段二再改' },
      tool('Edit', '2', { file_path: 'a.ts' }),
    ]
    const segs = buildConciseTimeline(process)
    expect(segs.map((s) => s.kind)).toEqual([
      'thinking',
      'tool_cluster',
      'narrative',
      'thinking',
      'tool_cluster',
    ])
  })

  it('merges adjacent pre-tool thinking into one fold', () => {
    const process: ProcessEntry[] = [
      { type: 'thinking', key: 't1', thinking: '一步分析内容' },
      { type: 'thinking', key: 't2', thinking: '二步继续分析' },
      tool('Bash', 'b1', { command: 'ls' }),
    ]
    const segs = buildConciseTimeline(process)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ kind: 'thinking' })
    if (segs[0]!.kind === 'thinking') {
      expect(segs[0].thinking).toContain('一步')
      expect(segs[0].thinking).toContain('二步')
    }
  })

  it('merges answerTexts as trailing narrative', () => {
    const process: ProcessEntry[] = [tool('Read', '1', { file_path: 'a.ts' })]
    const segs = buildConciseTimeline(process, {
      answerTexts: ['结论如下。'],
    })
    expect(segs.map((s) => s.kind)).toEqual(['tool_cluster', 'narrative'])
  })

  it('does not duplicate process text that matches answerTexts', () => {
    const process: ProcessEntry[] = [
      tool('Read', '1', { file_path: 'a.ts' }),
      { type: 'text', key: 'n1', text: '结论如下。' },
    ]
    const segs = buildConciseTimeline(process, {
      answerTexts: ['结论如下。'],
    })
    expect(segs.filter((s) => s.kind === 'narrative')).toHaveLength(1)
  })
})

describe('summarizeToolCluster', () => {
  it('names single edit file', () => {
    const t = tool('Edit', '1', { file_path: 'Foo.ts' }) as Extract<
      ProcessEntry,
      { type: 'tool' }
    >
    expect(summarizeToolCluster('edit', [t])).toBe('编辑了 Foo.ts')
  })
})
