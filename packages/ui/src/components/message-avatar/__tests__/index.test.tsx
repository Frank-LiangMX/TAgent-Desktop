import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { AssistantMessageLogo, ErrorMessageLogo, MESSAGE_AVATAR_SIZE } from '../index'

describe('AssistantMessageLogo', () => {
  test('renders fallback icon when no model and no logoResolver', () => {
    render(<AssistantMessageLogo />)
    const container = screen.getByTestId('fallback-container')
    expect(container).toHaveClass('size-[32px]')
  })

  test('renders image when logoResolver returns a URL', () => {
    const logoResolver = vi.fn().mockReturnValue('https://example.com/logo.png')
    render(<AssistantMessageLogo model="gpt-4" logoResolver={logoResolver} />)

    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'https://example.com/logo.png')
    expect(logoResolver).toHaveBeenCalledWith('gpt-4')
  })

  test('renders fallback when logoResolver returns null', () => {
    const logoResolver = vi.fn().mockReturnValue(null)
    render(<AssistantMessageLogo model="unknown" logoResolver={logoResolver} />)

    const container = screen.getByTestId('fallback-container')
    expect(container).toHaveClass('size-[32px]')
  })

  test('applies custom className', () => {
    render(<AssistantMessageLogo className="custom-class" />)
    const container = screen.getByTestId('fallback-container')
    expect(container).toHaveClass('custom-class')
  })

  test('uses custom fallbackIcon', () => {
    const customIcon = <span data-testid="custom-icon">★</span>
    render(<AssistantMessageLogo fallbackIcon={customIcon} />)
    expect(screen.getByTestId('custom-icon')).toBeInTheDocument()
  })

  test('exports MESSAGE_AVATAR_SIZE constant', () => {
    expect(MESSAGE_AVATAR_SIZE).toBe(32)
  })
})

describe('ErrorMessageLogo', () => {
  test('renders error icon container with correct size', () => {
    render(<ErrorMessageLogo />)
    const container = screen.getByTestId('error-container')
    expect(container).toHaveClass('size-[32px]')
  })

  test('applies custom className', () => {
    render(<ErrorMessageLogo className="error-class" />)
    const container = screen.getByTestId('error-container')
    expect(container).toHaveClass('error-class')
  })

  test('uses custom errorIcon', () => {
    const customIcon = <span data-testid="custom-error">⚠</span>
    render(<ErrorMessageLogo errorIcon={customIcon} />)
    expect(screen.getByTestId('custom-error')).toBeInTheDocument()
  })
})
