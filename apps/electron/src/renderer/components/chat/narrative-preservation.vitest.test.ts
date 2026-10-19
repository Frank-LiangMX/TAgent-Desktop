import { describe, expect, it } from 'vitest'
import { buildConciseTimeline } from './concise-timeline-model'
import { buildTurnPresentation, type ProcessEntry, type TurnSourceItem } from './session-turn-model'

const tool: Extract<ProcessEntry, { type: 'tool' }> = {
  type: 'tool', key: 'build',
  tool: { type: 'tool_use', id: 'build', name: 'Bash', input: { command: 'build' } },
}

// Regression fixtures: filenames, Markdown and complete decisions must survive tool arrival.
const paragraphs = [
  '引擎路径已确认。可以用 `Build.bat` 编译 host project 验证。\n\n先建立基线，避免后续改坏了分不清是谁的错。',
  '现在看 `Router.cpp:4415` 的 `/api/asset/tags` 循环——那也是重复保存点。以及现有 `fx` 前端调用节奏。',
  '`Intermediate/Build/BuildRules/` 里有 `HostModuleRules.dll`，说明**曾经**有 Source 目录和 Target.cs，但现在被删了。',
  '关键约束与决策：\n1. 每帧限量处理。\n2. 改完统一保存。\n\n```cpp\nTick(0.5);\n```\n\n' + '检查每个阶段的结果，再继续处理。'.repeat(200),
  '好的',
  '先看看入口文件。',
  '接着查一下缓存路径。',
  'Note: `state`.',
  "No output? That's odd.",
]

describe('narrative preservation at tool boundaries', () => {
  it.each(paragraphs)('keeps text and its key before tools, after tools and on reload (%#)', (text) => {
    const source: ProcessEntry[] = [{ type: 'text', key: 'text', text }]
    const before = buildConciseTimeline(source, { isLive: true })[0]
    expect(before).toMatchObject({ kind: 'narrative', text })
    for (const isLive of [true, false]) {
      const after = buildConciseTimeline([...source, tool], { isLive })
      expect(after[0]).toEqual(before)
      expect(after[1]?.kind).toBe('work_stage')
    }
  })

  it('keeps the same Pi text through partial → tool partial → final → history', () => {
    const text = paragraphs[3]!
    const message = {
      type: 'assistant' as const, uuid: 'pi-stable', modelId: 'test-model',
      content: [{ type: 'text' as const, text }],
    }
    const frames = [
      { message: { ...message, _partial: true }, live: true },
      { message: { ...message, _partial: true, content: [...message.content, tool.tool] }, live: true },
      { message: { ...message, stop_reason: 'toolUse', content: [...message.content, tool.tool] }, live: true },
      { message: { ...message, stop_reason: 'toolUse', content: [...message.content, tool.tool] }, live: false },
    ]
    for (const frame of frames) {
      const items: TurnSourceItem[] = [{ key: 'pi-stable', message: frame.message }]
      const presentation = buildTurnPresentation(
        { kind: 'assistant-turn', key: 'turn', items, isStreaming: frame.live },
        { isLiveTurn: frame.live, displayMode: 'concise' },
      )
      const narratives = buildConciseTimeline(presentation.process, { isLive: frame.live })
        .filter((segment) => segment.kind === 'narrative')
      expect(narratives).toHaveLength(1)
      expect(narratives[0]).toMatchObject({ key: 'narrative-0', text })
    }
  })
})
