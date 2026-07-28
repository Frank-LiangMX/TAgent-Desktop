import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { PlayPauseToggle } from '../index'

describe('PlayPauseToggle', () => {
  test('renders with default aria-label', () => {
    render(<PlayPauseToggle />)
    expect(screen.getByLabelText('播放 / 暂停')).toBeInTheDocument()
  })

  test('uncontrolled: toggles playing on click', async () => {
    const user = userEvent.setup()
    const onPlayingChange = vi.fn()
    render(<PlayPauseToggle defaultPlaying={false} onPlayingChange={onPlayingChange} />)

    const input = screen.getByLabelText('播放 / 暂停') as HTMLInputElement
    expect(input).not.toBeChecked()

    await user.click(input)
    expect(onPlayingChange).toHaveBeenCalledWith(true)
    expect(input).toBeChecked()

    await user.click(input)
    expect(onPlayingChange).toHaveBeenCalledWith(false)
    expect(input).not.toBeChecked()
  })

  test('controlled: reflects playing prop and notifies parent', async () => {
    const user = userEvent.setup()
    const onPlayingChange = vi.fn()
    const { rerender } = render(
      <PlayPauseToggle playing={false} onPlayingChange={onPlayingChange} />
    )

    const input = screen.getByLabelText('播放 / 暂停') as HTMLInputElement
    expect(input).not.toBeChecked()

    await user.click(input)
    expect(onPlayingChange).toHaveBeenCalledWith(true)
    // 受控：父未更新 prop 时仍保持 false
    expect(input).not.toBeChecked()

    rerender(<PlayPauseToggle playing={true} onPlayingChange={onPlayingChange} />)
    expect(input).toBeChecked()
  })

  test('applies custom size via CSS variable', () => {
    const { container } = render(<PlayPauseToggle size={24} />)
    const label = container.querySelector('.ui-play-pause-toggle') as HTMLElement
    expect(label.style.getPropertyValue('--ppt-size')).toBe('24px')
  })

  test('disabled prevents interaction', async () => {
    const user = userEvent.setup()
    const onPlayingChange = vi.fn()
    render(<PlayPauseToggle disabled onPlayingChange={onPlayingChange} />)

    const input = screen.getByLabelText('播放 / 暂停') as HTMLInputElement
    expect(input).toBeDisabled()
    await user.click(input)
    expect(onPlayingChange).not.toHaveBeenCalled()
  })

  test('merges custom className', () => {
    const { container } = render(<PlayPauseToggle className="my-toggle" />)
    const label = container.querySelector('.ui-play-pause-toggle') as HTMLElement
    expect(label).toHaveClass('my-toggle')
  })
})
