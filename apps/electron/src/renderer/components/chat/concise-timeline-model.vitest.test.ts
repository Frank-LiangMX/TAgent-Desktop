import { describe, expect, it } from 'vitest'
import type { ProcessEntry } from './session-turn-model'
import {
  buildConciseTimeline,
  classifyToolFamily,
  extractDiffHint,
  getLiveStatusFromSteps,
  getWorkStepLabel,
  isDeliverableThinking,
  isTrivialThinking,
  summarizeToolCluster,
  summarizeWorkStage,
} from './concise-timeline-model'

function tool(
  name: string,
  id: string,
  input: Record<string, unknown> = {},
  done = true,
  resultContent?: string,
): ProcessEntry {
  return {
    type: 'tool',
    key: id,
    tool: { type: 'tool_use', id, name, input },
    result: done
      ? {
          type: 'tool_result',
          toolUseId: id,
          content: resultContent ?? 'ok',
          isError: false,
        }
      : undefined,
  }
}

describe('classifyToolFamily', () => {
  it('maps explore/edit/shell/search', () => {
    expect(classifyToolFamily('Read')).toBe('explore')
    expect(classifyToolFamily('Grep')).toBe('search')
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

describe('summarizeWorkStage', () => {
  it('mixes edit/explore/search/shell into one Cursor-like line', () => {
    const tools = [
      tool('Edit', 'e1', { file_path: 'a.ts' }),
      tool('Edit', 'e2', { file_path: 'b.ts' }),
      tool('Read', 'r1', { file_path: 'd.ts' }),
      tool('Grep', 'g1', { pattern: 'x' }),
      tool('Grep', 'g2', { pattern: 'y' }),
      tool('Bash', 'b1', { command: 'git status' }),
    ] as Extract<ProcessEntry, { type: 'tool' }>[]
    expect(summarizeWorkStage(tools)).toBe(
      '编辑了 2 个文件，探索了 1 个文件，2 次搜索，运行了 1 条命令',
    )
  })
})

describe('extractDiffHint / live status', () => {
  it('parses +N -M from edit results', () => {
    const tools = [
      tool('Edit', 'e1', { file_path: 'a.ts' }, true, 'Updated a.ts +82 -48'),
    ] as Extract<ProcessEntry, { type: 'tool' }>[]
    expect(extractDiffHint(tools)).toBe('+82 -48')
  })

  it('live status shows current pending action', () => {
    const pending = tool('Grep', 'g1', { pattern: 'foo' }, false) as Extract<
      ProcessEntry,
      { type: 'tool' }
    >
    const status = getLiveStatusFromSteps([
      { kind: 'tool', key: 'g1', tool: pending },
    ])
    expect(status).toBe('搜索中')
  })
})

describe('buildConciseTimeline', () => {
  it('merges mixed-family tools in one work_stage with chronological steps', () => {
    const process: ProcessEntry[] = [
      tool('Read', '1', { file_path: 'a.ts' }),
      tool('Grep', '2', { pattern: 'x' }),
      tool('Bash', '3', { command: 'ls' }),
    ]
    const segs = buildConciseTimeline(process)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'work_stage' })
    const s0 = segs[0]!
    if (s0.kind === 'work_stage') {
      expect(s0.tools).toHaveLength(3)
      expect(s0.steps).toHaveLength(3)
      expect(s0.summary).toContain('探索了 1')
      expect(s0.summary).toContain('1 次搜索')
      expect(s0.summary).toContain('运行了 1')
    }
  })

  it('shows per-thinking duration from timestamps or length estimate', () => {
    const longThink =
      '这一段思考足够长，用来验证按长度粗估会得到「思考了 N 秒」而不是一律片刻。还要再写一句确保超过阈值。'
    const process: ProcessEntry[] = [
      {
        type: 'thinking',
        key: 't1',
        thinking: longThink,
        at: 1_000,
        durationSec: 6,
      },
      tool('Read', 'r1', { file_path: 'a.ts' }, true),
      {
        type: 'thinking',
        key: 't2',
        thinking:
          'Proma 我看了结构——它不是外围扩展，而是拿 **pi / Claude Agent SDK** 当内核，改造深度明显更激进。',
        at: 8_000,
        durationSec: 3,
      },
      tool('Edit', 'e1', { file_path: 'b.ts' }),
    ]
    const segs = buildConciseTimeline(process)
    expect(segs[0]).toMatchObject({ kind: 'thinking', summary: '思考了 6 秒', durationSec: 6 })
    const stage = segs[1]!
    expect(stage.kind).toBe('work_stage')
    if (stage.kind === 'work_stage') {
      const think = stage.steps.find((s) => s.kind === 'thinking')
      expect(think && think.kind === 'thinking' ? think.durationSec : undefined).toBe(3)
      expect(getWorkStepLabel(think!)).toBe('思考了 3 秒')
    }
  })

  it('interleaves thinking steps inside work_stage for expand view', () => {
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
      tool('Edit', 'e1', { file_path: 'a.ts' }, true, 'ok +10 -2'),
    ]
    const segs = buildConciseTimeline(process)
    expect(segs.map((s) => s.kind)).toEqual(['thinking', 'work_stage'])
    const stage = segs[1]!
    if (stage.kind === 'work_stage') {
      expect(stage.steps.map((s) => s.kind)).toEqual(['tool', 'tool', 'thinking', 'tool'])
      const think = stage.steps.find((s) => s.kind === 'thinking')
      expect(think && think.kind === 'thinking' ? think.thinking : '').toContain('**pi')
      expect(stage.diffAdd).toBe(10)
      expect(stage.diffDel).toBe(2)
      const editStep = stage.steps[3]!
      expect(editStep.kind === 'tool' && editStep.diff).toEqual({ add: 10, del: 2 })
      expect(getWorkStepLabel(editStep)).toBe('编辑 a.ts')
    }
  })

  it('shows progress narrative between stages', () => {
    const process: ProcessEntry[] = [
      { type: 'thinking', key: 't0', thinking: '先摸清目录再定改造面' },
      tool('Read', '1', { file_path: 'a.ts' }),
      tool('Bash', '3', { command: 'ls' }),
      {
        type: 'text',
        key: 'p1',
        text: '目录摸清了：问题在投影层，下一步改 concise 模型。',
      },
      tool('Edit', '4', { file_path: 'concise-timeline-model.ts' }),
      { type: 'text', key: 'f1', text: '已改成阶段工作块 + 进度短总结。' },
    ]
    const segs = buildConciseTimeline(process)
    expect(segs.map((s) => s.kind)).toEqual([
      'thinking',
      'work_stage',
      'narrative',
      'work_stage',
      'narrative',
    ])
    expect(segs[2]).toMatchObject({ kind: 'narrative', tone: 'progress' })
    expect(segs[4]).toMatchObject({ kind: 'narrative', tone: 'final' })
  })

  it('hides trivial inter-tool thinking', () => {
    const process: ProcessEntry[] = [
      { type: 'thinking', key: 't1', thinking: '先看目录结构再决定' },
      tool('Bash', 'b1', { command: 'dir' }),
      { type: 'thinking', key: 't2', thinking: '让我再读两个文件' },
      tool('Read', 'r1', { file_path: 'a.ts' }),
    ]
    const segs = buildConciseTimeline(process)
    const stage = segs[1]!
    if (stage.kind === 'work_stage') {
      expect(stage.steps.every((s) => s.kind === 'tool')).toBe(true)
      expect(stage.steps).toHaveLength(2)
    }
  })

  it('merges answerTexts as trailing final narrative', () => {
    const process: ProcessEntry[] = [tool('Read', '1', { file_path: 'a.ts' })]
    const segs = buildConciseTimeline(process, {
      answerTexts: ['结论如下。'],
    })
    expect(segs.map((s) => s.kind)).toEqual(['work_stage', 'narrative'])
    expect(segs[1]).toMatchObject({ kind: 'narrative', tone: 'final' })
  })

  it('pure text turn with no tools is final narrative', () => {
    const process: ProcessEntry[] = [
      { type: 'text', key: 'a', text: '你好。' },
      { type: 'text', key: 'b', text: '这是回答。' },
    ]
    const segs = buildConciseTimeline(process)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'narrative', tone: 'final' })
  })
  it('live trailing text stays progress (no final flash)', () => {
    const process: ProcessEntry[] = [
      tool('Read', '1', { file_path: 'a.ts' }),
      { type: 'text', key: 'n1', text: '正在写结论…' },
    ]
    const live = buildConciseTimeline(process, { isLive: true })
    expect(live.map((s) => s.kind)).toEqual(['work_stage', 'narrative'])
    expect(live[1]).toMatchObject({ kind: 'narrative', tone: 'progress' })

    const done = buildConciseTimeline(process, { isLive: false })
    expect(done[1]).toMatchObject({ kind: 'narrative', tone: 'final' })
  })
})

describe('summarizeToolCluster', () => {
  it('summarizes explore cluster', () => {
    const tools = [
      tool('Read', '1', { file_path: 'a.ts' }),
      tool('Read', '2', { file_path: 'b.ts' }),
    ] as Extract<ProcessEntry, { type: 'tool' }>[]
    expect(summarizeToolCluster('explore', tools)).toMatch(/探索了 2/)
  })
})
