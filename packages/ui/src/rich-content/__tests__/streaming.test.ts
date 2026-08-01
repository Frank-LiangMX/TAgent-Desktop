import { describe, expect, it } from 'vitest'

import { isRichFenceLanguage, unclosedFenceLanguage } from '../streaming'

describe('unclosedFenceLanguage', () => {
  it('无围栏返回 null', () => {
    expect(unclosedFenceLanguage('plain text')).toBeNull()
    expect(unclosedFenceLanguage('')).toBeNull()
  })

  it('已闭合围栏返回 null', () => {
    expect(unclosedFenceLanguage('```json\n{"a":1}\n```')).toBeNull()
    expect(unclosedFenceLanguage('a\n```ts\nx\n```\nb')).toBeNull()
  })

  it('未闭合围栏返回语言', () => {
    expect(unclosedFenceLanguage('```json\n{"a":')).toBe('json')
    expect(unclosedFenceLanguage('开始\n```datatable\n{"rows":')).toBe('datatable')
  })

  it('无语言围栏未闭合返回空串', () => {
    expect(unclosedFenceLanguage('```\nconst a =')).toBe('')
  })

  it('前面已闭合、末尾未闭合时返回末尾语言', () => {
    expect(unclosedFenceLanguage('```json\n{}\n```\n```mermaid\ngraph TD')).toBe('mermaid')
  })

  it('带语言后缀的围栏行不闭合（GFM 语义）', () => {
    // ```md 内嵌 ```js 行是内容，最后的 ``` 闭合 md → 全部闭合
    expect(unclosedFenceLanguage('```md\n```js\ncode\n```\n')).toBeNull()
  })
})

describe('isRichFenceLanguage', () => {
  it('富语言命中', () => {
    for (const lang of ['diff', 'json', 'mermaid', 'datatable', 'spreadsheet', 'pdf-preview']) {
      expect(isRichFenceLanguage(lang)).toBe(true)
    }
  })

  it('普通语言不命中', () => {
    for (const lang of ['ts', 'typescript', 'bash', 'text', '']) {
      expect(isRichFenceLanguage(lang)).toBe(false)
    }
  })

  it('大小写不敏感', () => {
    expect(isRichFenceLanguage('JSON')).toBe(true)
    expect(isRichFenceLanguage('Mermaid')).toBe(true)
  })
})
