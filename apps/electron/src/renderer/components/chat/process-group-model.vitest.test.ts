/**
 * 过程区折叠 / 预览逻辑单测（Vitest）
 *
 * 覆盖 W5b：live→idle 后进入自动折叠倒计时、用户手动 toggle 取消自动折、
 * 思考与中间文本的折叠阈值与纯文本预览。纯函数，node 环境直接跑。
 */
import { describe, expect, it } from 'vitest'
import type { ProcessEntry } from './session-turn-model'
import {
  PROCESS_TEXT_PREVIEW_MAX_CHARS,
  THINKING_PREVIEW_MAX_CHARS,
  THINKING_PREVIEW_MAX_LINES,
  buildProcessGroupHeaderLabel,
  buildProcessTextPreview,
  buildThinkingPreview,
  findLastProcessKey,
  planProcessGroupCollapse,
  projectConciseProcess,
  shouldCollapseProcessText,
  shouldCollapseThinking,
} from './process-group-model'

describe('planProcessGroupCollapse', () => {
  it('运行中自动展开', () => {
    expect(
      planProcessGroupCollapse({
        live: true,
        wasLive: false,
        userToggled: false,
        autoExpandWhenLive: true,
      }),
    ).toBe('expand')
  })

  it('新一轮开始时复位上一轮的手动 toggle', () => {
    expect(
      planProcessGroupCollapse({
        live: true,
        wasLive: false,
        userToggled: true,
        autoExpandWhenLive: true,
      }),
    ).toBe('expand')
  })

  it('本轮运行中用户手动收起后不再强制展开', () => {
    expect(
      planProcessGroupCollapse({
        live: true,
        wasLive: true,
        userToggled: true,
        autoExpandWhenLive: true,
      }),
    ).toBe('keep')
  })

  it('子代理详情页(autoExpandWhenLive=false)运行中未手动展开 → 强制收起（默认只一行摘要）', () => {
    expect(
      planProcessGroupCollapse({
        live: true,
        wasLive: true,
        userToggled: false,
        autoExpandWhenLive: false,
      }),
    ).toBe('collapse')
  })

  it('子代理详情页运行中用户已手动展开 → keep', () => {
    expect(
      planProcessGroupCollapse({
        live: true,
        wasLive: true,
        userToggled: true,
        autoExpandWhenLive: false,
      }),
    ).toBe('keep')
  })

  it('子代理详情页 live→idle 不进倒计时（折叠态无 3-2-1 闪）→ 直接收起', () => {
    expect(
      planProcessGroupCollapse({
        live: false,
        wasLive: true,
        userToggled: false,
        autoExpandWhenLive: false,
      }),
    ).toBe('collapse')
  })

  it('子代理详情页历史轮挂载（非本轮结束）直接收起', () => {
    expect(
      planProcessGroupCollapse({
        live: false,
        wasLive: false,
        userToggled: false,
        autoExpandWhenLive: false,
      }),
    ).toBe('collapse')
  })

  it('子代理详情页用户手动展开过 → live→idle 保持（keep）', () => {
    expect(
      planProcessGroupCollapse({
        live: false,
        wasLive: true,
        userToggled: true,
        autoExpandWhenLive: false,
      }),
    ).toBe('keep')
  })

  it('live→idle 进入倒计时', () => {
    expect(
      planProcessGroupCollapse({
        live: false,
        wasLive: true,
        userToggled: false,
        autoExpandWhenLive: true,
      }),
    ).toBe('countdown')
  })

  it('用户手动 toggle 过则取消自动折', () => {
    expect(
      planProcessGroupCollapse({
        live: false,
        wasLive: true,
        userToggled: true,
        autoExpandWhenLive: true,
      }),
    ).toBe('keep')
  })

  it('非本轮结束的静态渲染（历史轮挂载）直接收起', () => {
    expect(
      planProcessGroupCollapse({
        live: false,
        wasLive: false,
        userToggled: false,
        autoExpandWhenLive: true,
      }),
    ).toBe('collapse')
  })
})

describe('shouldCollapseThinking', () => {
  it('短思考不折叠', () => {
    expect(shouldCollapseThinking('先看一眼配置')).toBe(false)
    expect(shouldCollapseThinking('  \n ')).toBe(false)
  })

  it('超字数或超行数才折叠', () => {
    expect(shouldCollapseThinking('字'.repeat(THINKING_PREVIEW_MAX_CHARS + 1))).toBe(true)
    expect(shouldCollapseThinking('行\n'.repeat(THINKING_PREVIEW_MAX_LINES + 1))).toBe(true)
  })
})

describe('buildThinkingPreview', () => {
  it('只取前若干行', () => {
    const preview = buildThinkingPreview('a\nb\nc\nd\ne\nf')
    expect(preview.split('\n')).toHaveLength(THINKING_PREVIEW_MAX_LINES)
    expect(preview.endsWith('…')).toBe(true)
  })

  it('超字数截断', () => {
    const preview = buildThinkingPreview('字'.repeat(THINKING_PREVIEW_MAX_CHARS + 50))
    expect(preview).toHaveLength(THINKING_PREVIEW_MAX_CHARS + 1)
    expect(preview.endsWith('…')).toBe(true)
  })

  it('短内容原样返回', () => {
    expect(buildThinkingPreview('  查一下这个函数  ')).toBe('查一下这个函数')
  })
})

describe('过程内中间文本', () => {
  it('普通长度的中间文本不给折叠开关（完整可读）', () => {
    expect(shouldCollapseProcessText('我先读一下 ProcessGroupView，再决定怎么改。')).toBe(false)
  })

  it('超长中间文本才可折', () => {
    expect(shouldCollapseProcessText('字'.repeat(601))).toBe(true)
    expect(shouldCollapseProcessText('行\n'.repeat(13))).toBe(true)
  })

  it('预览行压成单行并截断', () => {
    const preview = buildProcessTextPreview(`第一行\n\n第二行${'字'.repeat(200)}`)
    expect(preview).not.toContain('\n')
    expect(preview).toHaveLength(PROCESS_TEXT_PREVIEW_MAX_CHARS + 1)
  })
})

describe('findLastProcessKey', () => {
  const process: ProcessEntry[] = [
    { type: 'thinking', key: 'think-0', thinking: '旧思考' },
    {
      type: 'tool',
      key: 'tool-1',
      tool: { type: 'tool_use', id: 't1', name: 'Read', input: {} },
    },
    { type: 'thinking', key: 'think-1', thinking: '当前思考' },
    { type: 'text', key: 'text-0', text: '中间正文' },
  ]

  it('只认末尾同类型条目（holdOpen 收窄依据）', () => {
    expect(findLastProcessKey(process, 'thinking')).toBe('think-1')
    expect(findLastProcessKey(process, 'text')).toBe('text-0')
    expect(findLastProcessKey(process, 'tool')).toBe('tool-1')
  })

  it('没有该类型时返回 null', () => {
    expect(findLastProcessKey([], 'thinking')).toBeNull()
  })
})

describe('buildProcessGroupHeaderLabel', () => {
  const base = {
    liveHint: null as string | null,
    toolCount: 0,
    thinkingCount: 0,
    toolsDone: 0,
    fallbackLabel: '执行过程',
    thinkingDurationSec: undefined as number | undefined,
  }

  it('live：提示 + 工具进度', () => {
    expect(
      buildProcessGroupHeaderLabel({
        ...base,
        live: true,
        liveHint: '正在思考…',
        toolCount: 2,
        toolsDone: 1,
        displayMode: 'full',
      }),
    ).toBe('正在思考… · 1/2')
  })

  it('full idle：步数 + 思考段数', () => {
    expect(
      buildProcessGroupHeaderLabel({
        ...base,
        live: false,
        toolCount: 3,
        thinkingCount: 2,
        displayMode: 'full',
      }),
    ).toBe('已执行 3 步 · 含 2 段思考')
  })

  it('concise idle：Cursor 风格「思考了 N 秒」', () => {
    expect(
      buildProcessGroupHeaderLabel({
        ...base,
        live: false,
        thinkingCount: 1,
        thinkingDurationSec: 12,
        displayMode: 'concise',
      }),
    ).toBe('思考了 12 秒')
  })

  it('concise idle：思考 + 工具', () => {
    expect(
      buildProcessGroupHeaderLabel({
        ...base,
        live: false,
        thinkingCount: 1,
        toolCount: 4,
        thinkingDurationSec: 8,
        displayMode: 'concise',
      }),
    ).toBe('思考了 8 秒 · 4 步')
  })

  it('concise idle：无思考仅工具', () => {
    expect(
      buildProcessGroupHeaderLabel({
        ...base,
        live: false,
        toolCount: 2,
        displayMode: 'concise',
      }),
    ).toBe('已执行 2 步')
  })

  it('concise idle：有思考但无时长 → 思考了几秒', () => {
    expect(
      buildProcessGroupHeaderLabel({
        ...base,
        live: false,
        thinkingCount: 1,
        displayMode: 'concise',
      }),
    ).toBe('思考了几秒')
  })
})

describe('projectConciseProcess', () => {
  it('所有 thinking 合并成一块（拼接文本），tool/text 保序', () => {
    const process: ProcessEntry[] = [
      { type: 'thinking', key: 'think-0', thinking: '先读文件' },
      { type: 'tool', key: 'tool-0', tool: { type: 'tool_use', id: 't0', name: 'Read', input: {} } },
      { type: 'thinking', key: 'think-1', thinking: '再想一下' },
      { type: 'tool', key: 'tool-1', tool: { type: 'tool_use', id: 't1', name: 'Edit', input: {} } },
      { type: 'text', key: 'text-0', text: '中间正文' },
    ]
    const out = projectConciseProcess(process)
    const thinks = out.filter((p) => p.type === 'thinking')
    expect(thinks).toHaveLength(1)
    expect(thinks[0]?.type === 'thinking' && thinks[0].thinking).toBe('先读文件\n\n再想一下')
    expect(thinks[0]?.type === 'thinking' && thinks[0].key).toBe('concise-thinking-merged')
    // 非 thinking 条目保序
    expect(out.map((p) => p.type)).toEqual(['thinking', 'tool', 'tool', 'text'])
  })

  it('无 thinking 时保序返回（仅 tool/text）', () => {
    const process: ProcessEntry[] = [
      { type: 'tool', key: 'tool-0', tool: { type: 'tool_use', id: 't0', name: 'Read', input: {} } },
      { type: 'text', key: 'text-0', text: '中间正文' },
    ]
    const out = projectConciseProcess(process)
    expect(out.map((p) => p.type)).toEqual(['tool', 'text'])
  })

  it('空 thinking 段被丢弃，不污染合并块', () => {
    const process: ProcessEntry[] = [
      { type: 'thinking', key: 'think-0', thinking: '有内容' },
      { type: 'thinking', key: 'think-1', thinking: '   ' },
    ]
    const out = projectConciseProcess(process)
    const thinks = out.filter((p) => p.type === 'thinking')
    expect(thinks).toHaveLength(1)
    expect(thinks[0]?.type === 'thinking' && thinks[0].thinking).toBe('有内容')
  })

  it('仅 thinking 时合并为单块', () => {
    const process: ProcessEntry[] = [
      { type: 'thinking', key: 'think-0', thinking: '一段' },
      { type: 'thinking', key: 'think-1', thinking: '二段' },
    ]
    const out = projectConciseProcess(process)
    expect(out).toHaveLength(1)
    expect(out[0]?.type === 'thinking' && out[0].thinking).toBe('一段\n\n二段')
  })

  it('投影幂等：再投影一次结果不变', () => {
    const process: ProcessEntry[] = [
      { type: 'thinking', key: 'think-0', thinking: '一段' },
      { type: 'tool', key: 'tool-0', tool: { type: 'tool_use', id: 't0', name: 'Read', input: {} } },
      { type: 'thinking', key: 'think-1', thinking: '二段' },
    ]
    expect(projectConciseProcess(projectConciseProcess(process))).toEqual(
      projectConciseProcess(process),
    )
  })
})
