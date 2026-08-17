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
  isFillerProgressText,
  isShortProgressText,
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

describe('buildConciseTimeline guidance', () => {
  it('keeps an injected guide as an ordered timeline item', () => {
    const process: ProcessEntry[] = [
      { type: 'text', key: 'before', text: '我先检查一下配置。' },
      { type: 'guidance', key: 'guide', text: '请优先验证本地窗口。' },
      tool('Read', 'read', { file_path: 'config.ts' }),
    ]

    expect(buildConciseTimeline(process)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'guidance', key: 'guide', text: '请优先验证本地窗口。' }),
      ]),
    )
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

  it('single-file edit uses filename (Cursor Edited Foo.tsx), not「编辑了 1 个文件」', () => {
    const tools = [
      tool('Edit', 'e1', {
        file_path: 'apps/electron/src/renderer/components/settings/CliWorkersSettingsSection.tsx',
      }, true, 'Updated +5 -5'),
    ] as Extract<ProcessEntry, { type: 'tool' }>[]
    expect(summarizeWorkStage(tools)).toBe('编辑了 CliWorkersSettingsSection.tsx')
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
    expect(status).toBe('搜索 foo')
  })

  it('live status shows Editing-style file name (Cursor)', () => {
    const pending = tool(
      'Edit',
      'e1',
      { file_path: 'apps/electron/src/renderer/components/chat/ComposerRunTimer.tsx' },
      false,
    ) as Extract<ProcessEntry, { type: 'tool' }>
    expect(
      getLiveStatusFromSteps([{ kind: 'tool', key: 'e1', tool: pending }]),
    ).toBe('编辑 ComposerRunTimer.tsx')
  })

  it('末步是思考时 live status 回「正在思考…」，不外露思考正文（concise 不流式完整思考链）', () => {
    // 回退 REGRESS-O O2：中段思考并入 stage.steps 后，末步思考只由底栏扫光提示，
    // 不再把思考正文作打字机常挂在阶段摘要下。展开 stage 才见全文。
    const deliverable =
      'Proma 我看了结构——它不是外围扩展，而是拿 **pi / Claude Agent SDK** 当内核，改造深度明显更激进。'
    const readTool = tool('Read', 'r1', { file_path: 'a.ts' }) as Extract<
      ProcessEntry,
      { type: 'tool' }
    >
    expect(
      getLiveStatusFromSteps([
        { kind: 'tool', key: 'r1', tool: readTool },
        { kind: 'thinking', key: 't1', thinking: deliverable },
      ]),
    ).toBe('正在思考…')
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
      // REGRESS-J(J3)：中段思考留在阶段 steps（展开可见全文），不再升独立 fold 拆阶段
      expect(stage.steps.map((s) => s.kind)).toEqual(['tool', 'thinking', 'tool'])
      expect(stage.steps[1]).toMatchObject({ kind: 'thinking', thinking: expect.stringContaining('**pi') })
    }
  })

  it('leading thinking stays top fold; mid-run deliverable thinking merges into one work_stage (REGRESS-J J3)', () => {
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
    // leading 思考独立 fold；中段 deliverable 思考留在 stage steps，不再拆出独立 fold
    expect(segs.map((s) => s.kind)).toEqual(['thinking', 'work_stage'])
    const stage = segs[1]!
    if (stage.kind === 'work_stage') {
      expect(stage.steps.map((s) => s.kind)).toEqual(['tool', 'tool', 'thinking', 'tool'])
      const mid = stage.steps[2]!
      if (mid.kind === 'thinking') expect(mid.thinking).toContain('**pi')
      expect(stage.diffAdd).toBe(10)
      expect(stage.diffDel).toBe(2)
      expect(getWorkStepLabel(stage.steps[3]!)).toBe('编辑了 a.ts')
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

  it('keeps mid-run deliverable thinking inside stage steps — one work_stage (REGRESS-J J3)', () => {
    const deliverable =
      'Proma 我看了结构——它不是外围扩展，而是拿 **pi / Claude Agent SDK** 当内核，改造深度明显更激进。'
    expect(isDeliverableThinking(deliverable)).toBe(true)
    const process: ProcessEntry[] = [
      tool('Read', 'r1', { file_path: 'a.ts' }),
      { type: 'thinking', key: 't1', thinking: deliverable },
      tool('Edit', 'e1', { file_path: 'b.ts' }),
    ]
    const segs = buildConciseTimeline(process)
    // 中段思考不再升独立 fold 打断阶段：Read | thinking | Edit 合并为一个 work_stage
    expect(segs.map((s) => s.kind)).toEqual(['work_stage'])
    const s0 = segs[0]!
    if (s0.kind === 'work_stage') {
      expect(s0.tools.map((t) => t.tool.name)).toEqual(['Read', 'Edit'])
      expect(s0.steps.map((s) => s.kind)).toEqual(['tool', 'thinking', 'tool'])
      const mid = s0.steps[1]!
      if (mid.kind === 'thinking') expect(mid.thinking).toBe(deliverable)
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

  it('keeps trivial inter-tool thinking in stage (REGRESS-K1，idle 可回看)', () => {
    const process: ProcessEntry[] = [
      { type: 'thinking', key: 't1', thinking: '先看目录结构再决定' },
      tool('Bash', 'b1', { command: 'dir' }),
      { type: 'thinking', key: 't2', thinking: '让我再读两个文件' },
      tool('Read', 'r1', { file_path: 'a.ts' }),
    ]
    const segs = buildConciseTimeline(process)
    expect(segs[0]?.kind).toBe('thinking')
    const stage = segs[1]!
    if (stage.kind === 'work_stage') {
      expect(stage.steps.map((s) => s.kind)).toEqual(['tool', 'thinking', 'tool'])
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

  it('drops tool-call artifact text (call / antml tail) before tools', () => {
    const process: ProcessEntry[] = [
      { type: 'text', key: 'n1', text: '分析 padding 不一致。' },
      { type: 'text', key: 'n2', text: 'call' },
      tool('Grep', 't1', { pattern: 'padding' }),
    ]
    const segs = buildConciseTimeline(process)
    expect(segs.map((s) => s.kind)).toEqual(['narrative', 'work_stage'])
    expect(segs[0]).toMatchObject({ kind: 'narrative', text: '分析 padding 不一致。' })
    expect(segs.some((s) => s.kind === 'narrative' && (s as { text: string }).text === 'call')).toBe(
      false,
    )
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

  it('live/idle 均保留 trivial 中段思考并入 stage（REGRESS-K1 不丢弃）', () => {
    const trivial = '让我再读两个文件'
    expect(isTrivialThinking(trivial)).toBe(true)
    const process: ProcessEntry[] = [
      tool('Read', 'r1', { file_path: 'a.ts' }),
      { type: 'thinking', key: 't1', thinking: trivial },
      tool('Grep', 'g1', { pattern: 'x' }),
    ]
    const live = buildConciseTimeline(process, { isLive: true })
    expect(live.map((s) => s.kind)).toEqual(['work_stage'])
    if (live[0]!.kind === 'work_stage') {
      expect(live[0]!.steps.map((s) => s.kind)).toEqual(['tool', 'thinking', 'tool'])
    }
    const done = buildConciseTimeline(process, { isLive: false })
    if (done[0]!.kind === 'work_stage') {
      expect(done[0]!.steps.map((s) => s.kind)).toEqual(['tool', 'thinking', 'tool'])
    }
  })

  it('live 与 idle 一致：deliverable 中段思考都留在 stage（不升独立 fold、不打断阶段）——REGRESS-J J3', () => {
    const deliverable =
      'Proma 我看了结构——它不是外围扩展，而是拿 **pi / Claude Agent SDK** 当内核，改造深度明显更激进。'
    expect(isDeliverableThinking(deliverable)).toBe(true)
    const process: ProcessEntry[] = [
      tool('Read', 'r1', { file_path: 'a.ts' }),
      { type: 'thinking', key: 't1', thinking: deliverable },
      tool('Edit', 'e1', { file_path: 'b.ts' }),
    ]
    // live：思考并入 stage（key=cur.key 稳定，不与 think-${cur.key} 互跳 remount）
    const live = buildConciseTimeline(process, { isLive: true })
    expect(live.map((s) => s.kind)).toEqual(['work_stage'])
    if (live[0]!.kind === 'work_stage') {
      expect(live[0]!.steps.map((s) => s.kind)).toEqual(['tool', 'thinking', 'tool'])
    }
    // idle：同样留在 stage，不再升独立 fold 拆 stage（展开步骤可见完整思考）
    const done = buildConciseTimeline(process, { isLive: false })
    expect(done.map((s) => s.kind)).toEqual(['work_stage'])
    if (done[0]!.kind === 'work_stage') {
      expect(done[0]!.steps.map((s) => s.kind)).toEqual(['tool', 'thinking', 'tool'])
    }
  })

  it('纯 filler 段间短文不拆 stage：tool → filler「好的」→ tool → tool = 1 个 work_stage（REGRESS-N 取代 J4）', () => {
    const filler = '好的'
    expect(isFillerProgressText(filler)).toBe(true)
    const process: ProcessEntry[] = [
      tool('Bash', 'b1', { command: 'git status' }),
      { type: 'text', key: 'p1', text: filler },
      tool('Bash', 'b2', { command: 'ls' }),
      tool('Bash', 'b3', { command: 'pwd' }),
    ]
    const segs = buildConciseTimeline(process)
    // filler 被吞，3 条工具合并为 1 个 work_stage；不增加多余 narrative（验收 2）
    expect(segs.map((s) => s.kind)).toEqual(['work_stage'])
    const stage = segs[0]!
    if (stage.kind === 'work_stage') {
      expect(stage.tools).toHaveLength(3)
      expect(stage.steps.every((s) => s.kind === 'tool')).toBe(true)
      expect(stage.summary).toContain('运行了 3 条命令')
    }
  })

  it('有信息的短段间 progress 不被 idle 丢：idle 含 ≥2 个 narrative.progress（REGRESS-N 验收 1）', () => {
    const shortProgress1 = '正在跑验证'
    const shortProgress2 = '改完核心逻辑'
    // 短且有信息：旧 isShortIdleProgress 会丢，现常驻 narrative.progress
    expect(isShortProgressText(shortProgress1)).toBe(true)
    expect(isShortProgressText(shortProgress2)).toBe(true)
    expect(isFillerProgressText(shortProgress1)).toBe(false)
    expect(isFillerProgressText(shortProgress2)).toBe(false)
    const process: ProcessEntry[] = [
      { type: 'thinking', key: 't0', thinking: '先摸清再改' },
      tool('Bash', 'b1', { command: 'git status' }),
      { type: 'text', key: 'p1', text: shortProgress1 },
      tool('Bash', 'b2', { command: 'ls' }),
      { type: 'text', key: 'p2', text: shortProgress2 },
      tool('Bash', 'b3', { command: 'pwd' }),
      { type: 'text', key: 'f1', text: '已改完核心逻辑并跑通验证，下面是改动说明与手测步骤。' },
    ]
    // live：三段 narrative 全是 progress（打字机即时可见）
    const live = buildConciseTimeline(process, { isLive: true })
    expect(
      live
        .filter((s) => s.kind === 'narrative' && (s as { tone: string }).tone === 'progress')
        .map((s) => (s as { text: string }).text),
    ).toEqual([shortProgress1, shortProgress2, '已改完核心逻辑并跑通验证，下面是改动说明与手测步骤。'])
    // idle：短有信息句不被丢 → ≥2 个 narrative.progress；末段长结论升 final（验收 1）
    const done = buildConciseTimeline(process, { isLive: false })
    expect(done.map((s) => s.kind)).toEqual([
      'thinking',
      'work_stage',
      'narrative',
      'work_stage',
      'narrative',
      'work_stage',
      'narrative',
    ])
    const progress = done.filter(
      (s) => s.kind === 'narrative' && (s as { tone: string }).tone === 'progress',
    )
    expect(progress.length).toBeGreaterThanOrEqual(2)
    expect(progress.map((s) => (s as { text: string }).text)).toEqual([shortProgress1, shortProgress2])
    const finalNarrative = done.find(
      (s) => s.kind === 'narrative' && (s as { tone: string }).tone === 'final',
    )
    expect((finalNarrative as { text: string }).text).toBe(
      '已改完核心逻辑并跑通验证，下面是改动说明与手测步骤。',
    )
  })

  it('较长的实质叙述仍作为阶段边界：work_stage | narrative | work_stage（不吞掉进度叙述）', () => {
    const substantive = '目录摸清了：问题在投影层，下一步改 concise 模型。'
    expect(isShortProgressText(substantive)).toBe(false)
    const process: ProcessEntry[] = [
      tool('Read', 'r1', { file_path: 'a.ts' }),
      tool('Bash', 'b1', { command: 'ls' }),
      { type: 'text', key: 'p1', text: substantive },
      tool('Edit', 'e1', { file_path: 'concise-timeline-model.ts' }),
      { type: 'text', key: 'f1', text: '已改成阶段工作块 + 进度短总结。' },
    ]
    const segs = buildConciseTimeline(process)
    expect(segs.map((s) => s.kind)).toEqual([
      'work_stage',
      'narrative',
      'work_stage',
      'narrative',
    ])
    expect(segs[1]).toMatchObject({ kind: 'narrative', tone: 'progress' })
    expect(segs[3]).toMatchObject({ kind: 'narrative', tone: 'final' })
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

  it('falls back to input line counts when result has no +N -M (real Write/Edit)', () => {
    const process: ProcessEntry[] = [
      tool(
        'Edit',
        'e1',
        {
          file_path: 'ChannelsSettings.tsx',
          old_string: 'a\nb\nc',
          new_string: 'a\nb\nc\nd\ne',
        },
        true,
        'ok',
      ),
      tool(
        'Write',
        'w1',
        {
          path: 'gen_views.py',
          content: 'line1\nline2\nline3',
        },
        true,
        'Wrote file',
      ),
      tool(
        'StrReplace',
        's1',
        {
          path: 'view.js',
          oldText: 'x',
          newText: 'x\ny',
        },
        true,
        'File updated',
      ),
    ]
    const files = collectTurnEditedFiles(process)
    expect(files).toEqual([
      expect.objectContaining({ name: 'ChannelsSettings.tsx', add: 5, del: 3 }),
      expect.objectContaining({ name: 'gen_views.py', add: 3, del: 0 }),
      expect.objectContaining({ name: 'view.js', add: 2, del: 1 }),
    ])
  })
})
