import { describe, expect, it } from 'vitest'

import { stripStructuralEmojiFromMarkdown } from './markdown-strip-emoji'

describe('stripStructuralEmojiFromMarkdown', () => {
  it('剥标题行首 emoji', () => {
    expect(stripStructuralEmojiFromMarkdown('## 📌 周六（必须锁定）')).toBe(
      '## 周六（必须锁定）',
    )
  })

  it('剥列表行首 emoji（可连续多个）', () => {
    expect(stripStructuralEmojiFromMarkdown('- 🎯 第1枪')).toBe('- 第1枪')
    expect(stripStructuralEmojiFromMarkdown('1. ✅ 完成')).toBe('1. 完成')
  })

  it('剥引用行首 emoji', () => {
    expect(stripStructuralEmojiFromMarkdown('> 💡 注意边界')).toBe('> 注意边界')
  })

  it('句中与普通段落保留', () => {
    expect(stripStructuralEmojiFromMarkdown('状态都标 ✅，但待手测')).toBe(
      '状态都标 ✅，但待手测',
    )
  })

  it('代码块内保留', () => {
    const src = '```\n# 📌 keep\n- 🎯 keep\n```\n## 📌 外面'
    expect(stripStructuralEmojiFromMarkdown(src)).toBe(
      '```\n# 📌 keep\n- 🎯 keep\n```\n## 外面',
    )
  })

  it('无 emoji 原样返回', () => {
    const src = '## 标题\n- 列表'
    expect(stripStructuralEmojiFromMarkdown(src)).toBe(src)
  })
})
