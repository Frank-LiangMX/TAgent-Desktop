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
  buildProcessTextPreview,
  buildThinkingPreview,
  findLastProcessKey,
  planProcessGroupCollapse,
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

  it('调用方关闭自动展开（子代理详情页）时运行中不展开', () => {
    expect(
      planProcessGroupCollapse({
        live: true,
        wasLive: true,
        userToggled: false,
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
