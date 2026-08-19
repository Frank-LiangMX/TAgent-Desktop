import { describe, expect, it } from 'vitest'
import {
  CHAT_MOUNT_BATCH,
  CHAT_MOUNT_TOP_LOAD_PX,
  CHAT_MOUNT_WINDOW,
} from './chat-mount-window'

describe('chat-mount-window', () => {
  it('keeps a finite streaming-friendly default window', () => {
    expect(CHAT_MOUNT_WINDOW).toBeGreaterThan(0)
    expect(CHAT_MOUNT_WINDOW).toBeLessThanOrEqual(80)
    expect(CHAT_MOUNT_BATCH).toBeGreaterThan(0)
    expect(CHAT_MOUNT_TOP_LOAD_PX).toBeGreaterThan(0)
  })

  it('caps oversized mount counts back to the window', () => {
    const clamp = (prev: number, itemsLength: number): number => {
      if (prev === Number.POSITIVE_INFINITY || prev > CHAT_MOUNT_WINDOW) {
        return Math.min(CHAT_MOUNT_WINDOW, itemsLength)
      }
      return prev
    }
    expect(clamp(Number.POSITIVE_INFINITY, 200)).toBe(CHAT_MOUNT_WINDOW)
    expect(clamp(120, 200)).toBe(CHAT_MOUNT_WINDOW)
    expect(clamp(20, 200)).toBe(20)
  })
})
