import { describe, expect, it } from 'vitest'
import {
  isToolCallArtifactText,
  sanitizeAssistantTextForDisplay,
  stripToolInvocationMarkup,
} from './tool-markup-text'

describe('stripToolInvocationMarkup', () => {
  it('strips complete antml invoke block', () => {
    const raw =
      '分析完毕\n<antml:invoke name="Grep">\n<antml:parameter name="pattern">foo</antml:parameter>\n</antml:invoke>'
    expect(stripToolInvocationMarkup(raw)).toBe('分析完毕')
  })

  it('strips opening antml tag only', () => {
    expect(stripToolInvocationMarkup('下一步\n<antml:invoke name="Read">')).toBe('下一步')
  })

  it('strips an antml parameter that is still streaming', () => {
    expect(
      stripToolInvocationMarkup('准备读取\n<antml:invoke name="Read">\n<antml:parameter name="path">src/App.tsx'),
    ).toBe('准备读取')
  })

  it('strips function_call / tool_call wrappers', () => {
    expect(stripToolInvocationMarkup('准备\n<function_call>\n{"name":"Read"}\n</function_call>')).toBe(
      '准备',
    )
    expect(stripToolInvocationMarkup('x\n<tool_call>')).toBe('x')
  })

  it('strips MiniMax / Pai DSML AskUserQuestion dump', () => {
    const raw =
      '< | DSML | tool_calls > < | DSML | invoke name="AskUserQuestion" > < | DSML | parameter name="questions" string="false" >[{"header":"实现方向","multiSelect":false,"options":[{"label":"独立 CLI 工具","description":"放 PATH"}]}]</pai_toolcalls>'
    expect(stripToolInvocationMarkup(raw)).toBe('')
    expect(
      stripToolInvocationMarkup('先确认方向\n' + raw),
    ).toBe('先确认方向')
  })

  it('strips lone pai_toolcalls closer', () => {
    expect(stripToolInvocationMarkup('</pai_toolcalls>')).toBe('')
    expect(stripToolInvocationMarkup('好的\n</pai_toolcalls>')).toBe('好的')
  })

  it('strips think blocks and orphan think/parameter closers', () => {
    expect(
      stripToolInvocationMarkup(
        '<think>User closed editor. Let me compile the plugin.</think>\n\n已完成修复。',
      ),
    ).toBe('已完成修复。')
    expect(
      stripToolInvocationMarkup(
        'User closed editor. Let me compile the plugin with the fixes, then the user can restart UE and test.</think>，</parameter>',
      ),
    ).toBe('')
    expect(
      stripToolInvocationMarkup('<think>still reasoning about the compile step'),
    ).toBe('')
    expect(stripToolInvocationMarkup('准备\n</parameter>')).toBe('准备')
    expect(
      stripToolInvocationMarkup('<parameter name="path">src/App.tsx</parameter>'),
    ).toBe('')
  })
})

describe('isToolCallArtifactText', () => {
  it('treats bare call/calling as artifact', () => {
    expect(isToolCallArtifactText('call')).toBe(true)
    expect(isToolCallArtifactText('calling…')).toBe(true)
    expect(isToolCallArtifactText('function_call')).toBe(true)
  })

  it('keeps substantive progress text', () => {
    expect(isToolCallArtifactText('准备编辑 agent-behavior-settings.css')).toBe(false)
    expect(isToolCallArtifactText('正在搜索 padding 定义')).toBe(false)
  })

  it('markup-only chunks are artifact', () => {
    expect(isToolCallArtifactText('<antml:invoke name="Grep">')).toBe(true)
    expect(isToolCallArtifactText('<function_call>')).toBe(true)
  })
})

describe('sanitizeAssistantTextForDisplay', () => {
  it('returns cleaned natural language', () => {
    expect(
      sanitizeAssistantTextForDisplay('好的\n<antml:invoke name="Glob">'),
    ).toBe('好的')
  })
})
