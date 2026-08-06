import { describe, expect, it } from 'vitest'
import type { ProcessEntry } from './session-turn-model'
import { formatThinkingSummary } from './session-turn-model'
import {
  buildConciseTimeline,
  classifyToolFamily,
  collectTurnEditedFiles,
  extractDiffHint,
  getLiveStatusFromSteps,
  getWorkStepLabel,
  isDeliverableThinking,
  isTrivialThinking,
  summarizeToolCluster,
  summarizeWorkStage,
} from './concise-timeline-model'
import { isOneShotTextJump } from './narrative-oneshot'

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
    expect(segs[0]).toMatchObject({ kind: 'thinking', summary: '思考了 6s', durationSec: 6 })
    const stage = segs[1]!
    expect(stage.kind).toBe('work_stage')
    if (stage.kind === 'work_stage') {
      // 中段思考已升为独立 ThinkingFold，不再埋进阶段 steps
      expect(stage.steps.every((s) => s.kind === 'tool')).toBe(true)
    }
  })

  it('lifts mid-run thinking to top-level fold between stages (Cursor)', () => {
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
    expect(segs.map((s) => s.kind)).toEqual([
      'thinking',
      'work_stage',
      'thinking',
      'work_stage',
    ])
    const mid = segs[2]!
    expect(mid.kind).toBe('thinking')
    if (mid.kind === 'thinking') {
      expect(mid.thinking).toContain('**pi')
    }
    const editStage = segs[3]!
    if (editStage.kind === 'work_stage') {
      expect(editStage.steps.map((s) => s.kind)).toEqual(['tool'])
      expect(editStage.diffAdd).toBe(10)
      expect(editStage.diffDel).toBe(2)
      expect(getWorkStepLabel(editStage.steps[0]!)).toBe('编辑 a.ts')
    }
  })

  it('folds mid-run ordinary (non-deliverable) thinking into stage steps — one work_stage (Cursor 节奏聚合)', () => {
    const midThink = '比对两个文件的结构差异，逐行确认改造范围是否一致。'
    // 前置断言：非琐碎且非可交付 → 应并入阶段而非刷独立折叠
    expect(isTrivialThinking(midThink)).toBe(false)
    expect(isDeliverableThinking(midThink)).toBe(false)
    const process: ProcessEntry[] = [
      tool('Read', 'r1', { file_path: 'a.ts' }),
      { type: 'thinking', key: 't1', thinking: midThink },
      tool('Grep', 'g1', { pattern: 'x' }),
      tool('Bash', 'b1', { command: 'ls' }),
    ]
    const segs = buildConciseTimeline(process)
    // 一个 work_stage：思考收进 steps，summary 聚合三族，不拆阶段、不刷独立 ThinkingFold
    expect(segs.map((s) => s.kind)).toEqual(['work_stage'])
    const stage = segs[0]!
    if (stage.kind === 'work_stage') {
      expect(stage.tools).toHaveLength(3)
      expect(stage.steps.map((s) => s.kind)).toEqual(['tool', 'thinking', 'tool', 'tool'])
      expect(stage.steps[1]).toMatchObject({ kind: 'thinking', thinking: midThink })
      expect(stage.summary).toContain('探索了 1')
      expect(stage.summary).toContain('1 次搜索')
      expect(stage.summary).toContain('运行了 1')
    }
  })

  it('lifts mid-run deliverable thinking to split stages — work_stage | thinking | work_stage', () => {
    const deliverable =
      'Proma 我看了结构——它不是外围扩展，而是拿 **pi / Claude Agent SDK** 当内核，改造深度明显更激进。'
    expect(isDeliverableThinking(deliverable)).toBe(true)
    const process: ProcessEntry[] = [
      tool('Read', 'r1', { file_path: 'a.ts' }),
      { type: 'thinking', key: 't1', thinking: deliverable },
      tool('Edit', 'e1', { file_path: 'b.ts' }),
    ]
    const segs = buildConciseTimeline(process)
    expect(segs.map((s) => s.kind)).toEqual(['work_stage', 'thinking', 'work_stage'])
    const mid = segs[1]!
    if (mid.kind === 'thinking') expect(mid.thinking).toBe(deliverable)
    const s0 = segs[0]!
    if (s0.kind === 'work_stage') expect(s0.tools.map((t) => t.tool.name)).toEqual(['Read'])
    const s2 = segs[2]!
    if (s2.kind === 'work_stage') expect(s2.tools.map((t) => t.tool.name)).toEqual(['Edit'])
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

describe('formatThinkingSummary (Cursor briefly)', () => {
  it('<3s 或缺省 → 思考了片刻；>=3s → 思考了 Ns', () => {
    expect(formatThinkingSummary(1)).toBe('思考了片刻')
    expect(formatThinkingSummary(2)).toBe('思考了片刻')
    expect(formatThinkingSummary(0)).toBe('思考了片刻')
    expect(formatThinkingSummary(undefined)).toBe('思考了片刻')
    expect(formatThinkingSummary(46)).toBe('思考了 46s')
    expect(formatThinkingSummary(3)).toBe('思考了 3s')
  })

  it('live 文案不变', () => {
    expect(formatThinkingSummary(undefined, { live: true })).toBe('正在思考…')
    expect(formatThinkingSummary(1, { live: true })).toBe('正在思考…')
    expect(formatThinkingSummary(1, { live: true, liveElapsedSec: 3 })).toBe('思考中 3s')
  })
})

describe('isOneShotTextJump (NarrativeRow)', () => {
  it('detects empty→large and large relative jumps', () => {
    expect(isOneShotTextJump(0, 100)).toBe(true)
    expect(isOneShotTextJump(10, 200)).toBe(true)
    expect(isOneShotTextJump(0, 20)).toBe(false)
    expect(isOneShotTextJump(100, 150)).toBe(false)
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

describe('collectTurnEditedFiles', () => {
  it('merges edits by path and skips pending / non-edit', () => {
    const process: ProcessEntry[] = [
      tool('Read', 'r1', { file_path: 'a.ts' }, true, 'ok'),
      tool('Edit', 'e1', { file_path: 'src/ConciseTimelineView.tsx' }, true, 'Updated +2 -1'),
      tool('StrReplace', 'e2', { path: 'src/AssistantTurnView.tsx' }, true, 'ok +1 -1'),
      tool('Write', 'e3', { filePath: 'apps/electron/src/renderer/styles/chat.css' }, true, '+11 -1'),
      tool('Edit', 'e4', { file_path: 'src/ConciseTimelineView.tsx' }, true, 'Updated +3 -0'),
      tool('Edit', 'pending', { file_path: 'wip.ts' }, false),
    ]
    const files = collectTurnEditedFiles(process)
    expect(files.map((f) => f.name)).toEqual([
      'ConciseTimelineView.tsx',
      'AssistantTurnView.tsx',
      'chat.css',
    ])
    expect(files[0]).toMatchObject({ add: 5, del: 1 })
    expect(files[1]).toMatchObject({ add: 1, del: 1 })
    expect(files[2]).toMatchObject({ add: 11, del: 1 })
  })

  it('classifies StrReplace as edit', () => {
    expect(classifyToolFamily('StrReplace')).toBe('edit')
  })
})
