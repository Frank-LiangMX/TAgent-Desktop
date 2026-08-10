// @vitest-environment jsdom
/**
 * B 验收：思考折叠块 lazy-mount（renderer 端，遵循「不引入 @testing-library 等渲染依赖」约定，
 * 用根级 react-dom/client + react 的 act 自测）。
 * - concise（ThinkingFold）/ full（ThinkingActivityRow）默认折叠 → 不挂载 MessageResponse/Markdown body。
 * - 主动展开 → 出现完整 Markdown；关闭 → 卸载。
 * - a11y：aria-expanded / aria-controls 随开合切换。
 */
import { describe, expect, test } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ThinkingFold } from './ConciseTimelineView'
import { ThinkingActivityRow } from './ProcessGroupView'

// React 18 act 环境标记（消除 "not configured to support act" 警告）
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const THINKING_MD =
  '# 思考标题\n\n这是一段**完整思考**正文，含代码 `foo()` 与列表：\n\n- 一\n- 二'

interface Mount {
  container: HTMLDivElement
  root: Root
  unmount(): void
}

function mount(jsx: React.ReactElement): Mount {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(jsx)
  })
  return {
    container,
    root,
    unmount() {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** 点击文本匹配正则的第一个 button（act 包裹触发同步 setState） */
function clickButton(container: HTMLElement, re: RegExp): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    re.test(b.textContent ?? ''),
  ) as HTMLButtonElement
  expect(btn).toBeTruthy()
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return btn
}

describe('B: ThinkingFold（concise）lazy-mount', () => {
  test('折叠时不挂载 MessageResponse/Markdown body', () => {
    const { container, unmount } = mount(<ThinkingFold thinking={THINKING_MD} isLive={false} />)
    // 头栏在位
    expect(container.querySelector('.agent-concise-fold__head')).toBeTruthy()
    // body 未挂载：无 body 容器、无 markdown 文本
    expect(container.querySelector('.agent-concise-fold__body')).toBeNull()
    expect(container.textContent).not.toContain('完整思考')
    expect(container.textContent).not.toContain('思考标题')
    unmount()
  })

  test('展开后出现完整 Markdown；aria-expanded/aria-controls 正确', () => {
    const { container, unmount } = mount(<ThinkingFold thinking={THINKING_MD} isLive={false} />)
    const head = container.querySelector<HTMLButtonElement>('.agent-concise-fold__head')!
    expect(head.getAttribute('aria-expanded')).toBe('false')
    const controls = head.getAttribute('aria-controls')
    expect(controls).toBeTruthy()

    clickButton(container, /思考/)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    // body 挂载 + markdown 渲染
    expect(container.querySelector('.agent-concise-fold__body')).not.toBeNull()
    expect(container.textContent).toContain('完整思考')
    expect(container.textContent).toContain('思考标题')
    // panel id 与 aria-controls 对应（useId() 产出含冒号，用 getElementById 免转义）
    expect(document.getElementById(controls as string)).not.toBeNull()
    unmount()
  })

  test('关闭后卸载重型正文（body 与 markdown 文本消失）', () => {
    const { container, unmount } = mount(<ThinkingFold thinking={THINKING_MD} isLive={false} />)
    const head = container.querySelector<HTMLButtonElement>('.agent-concise-fold__head')!
    clickButton(container, /思考/) // 展开
    expect(container.querySelector('.agent-concise-fold__body')).not.toBeNull()
    expect(container.textContent).toContain('完整思考')
    clickButton(container, /思考/) // 关闭
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.agent-concise-fold__body')).toBeNull()
    expect(container.textContent).not.toContain('完整思考')
    unmount()
  })
})

describe('B: ThinkingActivityRow（full）lazy-mount', () => {
  test('折叠不挂载 body；展开→完整 Markdown；关闭→卸载', () => {
    const { container, unmount } = mount(
      <ThinkingActivityRow thinking={THINKING_MD} isLive={false} durationSec={3} />,
    )
    const head = container.querySelector<HTMLButtonElement>('.agent-thinking-row__head')!
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(head.getAttribute('aria-controls')).toBeTruthy()
    // 折叠：无 body / 无 markdown
    expect(container.querySelector('.agent-thinking-row__body')).toBeNull()
    expect(container.textContent).not.toContain('完整思考')

    clickButton(container, /思考/) // 展开
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.agent-thinking-row__body')).not.toBeNull()
    expect(container.textContent).toContain('完整思考')

    clickButton(container, /思考/) // 关闭
    expect(container.querySelector('.agent-thinking-row__body')).toBeNull()
    expect(container.textContent).not.toContain('完整思考')
    unmount()
  })
})
