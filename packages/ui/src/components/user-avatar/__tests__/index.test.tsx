import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import userEvent from '@testing-library/user-event'

import { UserAvatar } from '../index'

describe('UserAvatar', () => {
  test('renders emoji avatar with correct size', () => {
    const { container } = render(<UserAvatar avatar="🤖" size={48} />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper).toHaveStyle({ width: '48px', height: '48px' })
  })

  test('renders image avatar from data URL', () => {
    const dataUrl = 'data:image/png;base64,abc123'
    render(<UserAvatar avatar={dataUrl} />)
    const img = screen.getByAltText('用户头像')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src', dataUrl)
  })

  test('renders image avatar from http URL', () => {
    const httpUrl = 'https://example.com/avatar.png'
    render(<UserAvatar avatar={httpUrl} />)
    const img = screen.getByAltText('用户头像')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src', httpUrl)
  })

  test('applies custom className', () => {
    const { container } = render(<UserAvatar avatar="😊" className="my-class" />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper).toHaveClass('my-class')
  })

  test('calls onClick when clicked', async () => {
    const user = userEvent.setup()
    const handleClick = vi.fn()
    const { container } = render(<UserAvatar avatar="🎉" onClick={handleClick} />)
    const wrapper = container.firstElementChild as HTMLElement
    await user.click(wrapper)
    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  test('applies cursor-pointer when onClick is provided', () => {
    const { container } = render(<UserAvatar avatar="🎉" onClick={() => {}} />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper).toHaveClass('cursor-pointer')
  })

  test('does not apply cursor-pointer when onClick is not provided', () => {
    const { container } = render(<UserAvatar avatar="🎉" />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper).not.toHaveClass('cursor-pointer')
  })

  test('uses default size of 32', () => {
    const { container } = render(<UserAvatar avatar="😊" />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper).toHaveStyle({ width: '32px', height: '32px' })
  })

  test('calculates font size as 50% of size', () => {
    const { container } = render(<UserAvatar avatar="😊" size={60} />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper).toHaveStyle({ fontSize: '30px' })
  })
})
