import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AddonLoader } from '../index'

describe('AddonLoader（附加动画）', () => {
  test('默认文案与附加动画标记', () => {
    const { container } = render(<AddonLoader />)
    const root = container.querySelector('.ui-addon-loader') as HTMLElement
    expect(root).toBeInTheDocument()
    expect(root).toHaveAttribute('data-addon-animation', 'true')
    expect(root).toHaveAttribute('data-animation-kind', 'addon')
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '加载中')
  })

  test('按字符拆分自定义 text', () => {
    const { container } = render(<AddonLoader text="生成中" />)
    const letters = container.querySelectorAll('.ui-addon-loader__letter')
    expect(letters).toHaveLength(3)
    expect(letters[0]).toHaveTextContent('生')
    expect(letters[1]).toHaveTextContent('成')
    expect(letters[2]).toHaveTextContent('中')
  })

  test('size 写入 CSS 变量', () => {
    const { container } = render(<AddonLoader size={120} />)
    const root = container.querySelector('.ui-addon-loader') as HTMLElement
    expect(root.style.getPropertyValue('--ui-addon-loader-size')).toBe('120px')
  })

  test('渲染光环层', () => {
    const { container } = render(<AddonLoader />)
    expect(container.querySelector('.ui-addon-loader__ring')).toBeInTheDocument()
  })
})
