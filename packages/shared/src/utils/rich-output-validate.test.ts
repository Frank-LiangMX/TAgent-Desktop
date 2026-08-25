import { describe, expect, it } from 'vitest'

import { buildOutputStylePrompt } from './output-style-prompt'
import {
  buildRichContentSystemPrompt,
  buildRichOutputFixPrompt,
  isRichFenceLanguage,
  unclosedFenceLanguage,
  validateRichOutput,
} from './rich-output-validate'

describe('unclosedFenceLanguage', () => {
  it('无围栏返回 null', () => {
    expect(unclosedFenceLanguage('plain')).toBeNull()
  })

  it('闭合围栏返回 null', () => {
    expect(unclosedFenceLanguage('```json\n{}\n```')).toBeNull()
  })

  it('未闭合返回语言', () => {
    expect(unclosedFenceLanguage('```datatable\n{"rows":')).toBe('datatable')
  })
})

describe('isRichFenceLanguage', () => {
  it('富语言命中、普通语言不命中', () => {
    expect(isRichFenceLanguage('mermaid')).toBe(true)
    expect(isRichFenceLanguage('datatable')).toBe(true)
    expect(isRichFenceLanguage('typescript')).toBe(false)
  })
})

describe('validateRichOutput', () => {
  it('正常回复无 issue', () => {
    const text = '结果如下：\n```json\n{"a":1}\n```\n```datatable\n{"columns":["x"],"rows":[[1]]}\n```'
    expect(validateRichOutput(text)).toEqual([])
  })

  it('未闭合富围栏报 issue', () => {
    const issues = validateRichOutput('```mermaid\ngraph TD\nA-->B')
    expect(issues).toHaveLength(1)
    expect(issues[0]!.kind).toBe('unclosed-fence')
    expect(issues[0]!.language).toBe('mermaid')
  })

  it('坏 JSON 报 issue', () => {
    const issues = validateRichOutput('```json\n{"a": 1,}\n```')
    expect(issues.some((i) => i.kind === 'bad-json')).toBe(true)
  })

  it('datatable schema 错误报 issue', () => {
    const issues = validateRichOutput('```datatable\n[1,2,3]\n```')
    expect(issues.some((i) => i.kind === 'bad-datatable')).toBe(true)
  })

  it('普通语言围栏不校验', () => {
    const issues = validateRichOutput('```typescript\nconst a: string = 1\n```')
    expect(issues).toEqual([])
  })

  it('空输入返回空', () => {
    expect(validateRichOutput('')).toEqual([])
  })
})

describe('buildRichOutputFixPrompt', () => {
  it('包含问题清单与要求', () => {
    const prompt = buildRichOutputFixPrompt(
      [{ kind: 'bad-json', language: 'json', index: 0, message: 'JSON 围栏内容无法解析' }],
      '```json\n{a:1}\n```',
    )
    expect(prompt).toContain('富内容格式有问题')
    expect(prompt).toContain('JSON 围栏内容无法解析')
    expect(prompt).toContain('重新输出')
  })
})

describe('W8 output style + rich content gate', () => {
  it('buildOutputStylePrompt 含输出风格标题与禁装饰 emoji', () => {
    const prompt = buildOutputStylePrompt()
    expect(prompt).toContain('输出风格')
    expect(prompt).toContain('装饰 emoji')
    expect(prompt).toContain('思考草稿不得进入可见正文')
  })

  it('buildRichContentSystemPrompt 含按需门槛', () => {
    expect(buildRichContentSystemPrompt()).toContain('按需')
  })
})
