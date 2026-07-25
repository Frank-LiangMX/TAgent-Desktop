import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import userEvent from '@testing-library/user-event'

import { ContextDivider } from '../index'

describe('ContextDivider', () => {
  test('renders divider with label', () => {
    render(<ContextDivider messageId="msg-1" />)
    expect(screen.getByText('清除上下文')).toBeInTheDocument()
  })

  test('calls onDelete with messageId when close button is clicked', async () => {
    const user = userEvent.setup()
    const handleDelete = vi.fn()
    render(<ContextDivider messageId="msg-123" onDelete={handleDelete} />)

    const closeButton = screen.getByRole('button', { name: '删除分隔线' })
    await user.click(closeButton)

    expect(handleDelete).toHaveBeenCalledWith('msg-123')
  })

  test('does not throw when onDelete is not provided', async () => {
    const user = userEvent.setup()
    render(<ContextDivider messageId="msg-1" />)

    const closeButton = screen.getByRole('button', { name: '删除分隔线' })
    await user.click(closeButton)
    // Should not throw
  })

  test('applies custom className', () => {
    const { container } = render(<ContextDivider messageId="msg-1" className="my-divider" />)
    // className is applied to the root div
    expect(container.firstElementChild).toHaveClass('my-divider')
  })

  test('renders dashed lines on both sides', () => {
    const { container } = render(<ContextDivider messageId="msg-1" />)
    const root = container.firstElementChild as HTMLElement
    const dashedLines = root.querySelectorAll('.border-dashed')
    expect(dashedLines).toHaveLength(2)
  })
})
