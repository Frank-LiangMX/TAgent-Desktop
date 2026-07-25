import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import userEvent from '@testing-library/user-event'

import { Switch } from '../switch'

describe('Switch', () => {
  test('default size 使用 ui-switch--default', () => {
    render(<Switch aria-label="开关" />)
    const root = screen.getByRole('switch')
    expect(root).toHaveClass('ui-switch')
    expect(root).toHaveClass('ui-switch--default')
    expect(root).toHaveAttribute('data-size', 'default')
  })

  test('sm size 使用 ui-switch--sm', () => {
    render(<Switch size="sm" aria-label="紧凑开关" />)
    const root = screen.getByRole('switch')
    expect(root).toHaveClass('ui-switch--sm')
    expect(root).toHaveAttribute('data-size', 'sm')
  })

  test('受控切换触发 onCheckedChange', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="受控" />)

    await user.click(screen.getByRole('switch'))
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  test('disabled 不可点击', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Switch disabled checked={false} onCheckedChange={onCheckedChange} aria-label="禁用" />)

    await user.click(screen.getByRole('switch'))
    expect(onCheckedChange).not.toHaveBeenCalled()
  })

  test('渲染轨道与拇指结构（Uiverse 主题色开关）', () => {
    const { container } = render(<Switch aria-label="结构" />)
    expect(container.querySelector('.ui-switch-track')).toBeInTheDocument()
    expect(container.querySelector('.ui-switch-thumb')).toBeInTheDocument()
  })
})
