import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConversationEmptyState } from '../index'

describe('ConversationEmptyState', () => {
  test('renders default title and description', () => {
    render(<ConversationEmptyState />)
    expect(screen.getByText('暂无消息')).toBeInTheDocument()
    expect(screen.getByText('在下方输入框开始对话')).toBeInTheDocument()
  })

  test('renders custom title', () => {
    render(<ConversationEmptyState title="自定义标题" />)
    expect(screen.getByText('自定义标题')).toBeInTheDocument()
    expect(screen.queryByText('暂无消息')).not.toBeInTheDocument()
  })

  test('renders custom description', () => {
    render(<ConversationEmptyState description="自定义描述" />)
    expect(screen.getByText('自定义描述')).toBeInTheDocument()
    expect(screen.queryByText('在下方输入框开始对话')).not.toBeInTheDocument()
  })

  test('renders icon when provided', () => {
    const icon = <span data-testid="test-icon">📱</span>
    render(<ConversationEmptyState icon={icon} />)
    expect(screen.getByTestId('test-icon')).toBeInTheDocument()
  })

  test('does not render icon when not provided', () => {
    render(<ConversationEmptyState />)
    expect(screen.queryByRole('img', { hidden: true })).not.toBeInTheDocument()
  })

  test('renders children instead of default content', () => {
    render(
      <ConversationEmptyState>
        <div data-testid="custom-content">自定义内容</div>
      </ConversationEmptyState>
    )
    expect(screen.getByTestId('custom-content')).toBeInTheDocument()
    expect(screen.queryByText('暂无消息')).not.toBeInTheDocument()
  })

  test('applies custom className', () => {
    render(<ConversationEmptyState className="custom-class" />)
    const container = screen.getByText('暂无消息').closest('div')?.parentElement
    expect(container).toHaveClass('custom-class')
  })

  test('hides description when empty string is passed', () => {
    render(<ConversationEmptyState description="" />)
    expect(screen.getByText('暂无消息')).toBeInTheDocument()
    expect(screen.queryByText('在下方输入框开始对话')).not.toBeInTheDocument()
  })
})
