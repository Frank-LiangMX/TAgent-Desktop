import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { MessageResponse } from '../index'

/**
 * 无语言标注的围栏块历史上会掉进行内代码分支（pre 被拆掉 → 丢 white-space:pre），
 * 目录树这类靠空白对齐的内容会被挤成一坨。这里锁住块级 / 行内的分流。
 */
describe('MessageResponse 代码渲染', () => {
  test('无语言标注的围栏块渲染为代码块而非行内代码', () => {
    const tree = ['TAgent-Desktop/', '├── apps/electron/', '└── packages/'].join('\n')

    const { container } = render(
      <MessageResponse>{'```\n' + tree + '\n```'}</MessageResponse>
    )

    // 代码块外壳存在（CodeBlock 渲染 pre），且未退化成行内 code chip
    expect(container.querySelector('pre')).not.toBeNull()
    expect(container.querySelector('code.bg-foreground\\/\\[0\\.05\\]')).toBeNull()
  })

  test('行内代码仍走 chip 样式，不产生代码块', () => {
    const { container } = render(
      <MessageResponse>{'定位在 `src/main/lib` 目录。'}</MessageResponse>
    )

    expect(container.querySelector('pre')).toBeNull()
    const inline = container.querySelector('code')
    expect(inline).not.toBeNull()
    expect(inline?.className).toContain('font-mono')
  })

  test('带语言标注的围栏块仍渲染为代码块', () => {
    const { container } = render(
      <MessageResponse>{'```ts\nconst a = 1\n```'}</MessageResponse>
    )

    expect(container.querySelector('pre')).not.toBeNull()
    expect(screen.getByText(/const/)).toBeTruthy()
  })
})
