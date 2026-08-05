import { describe, expect, test } from 'vitest'
import { PERMISSION_TIMEOUT_MS } from '@tagent/shared'
import {
  buildPermissionTimeoutSessionError,
  formatPermissionCountdown,
  getPermissionRemainingMs,
} from './permission-atoms'

describe('getPermissionRemainingMs', () => {
  test('returns full timeout when just requested', () => {
    const now = 1_000_000
    expect(getPermissionRemainingMs({ requestedAt: now }, now)).toBe(PERMISSION_TIMEOUT_MS)
  })

  test('clamps at zero after deadline', () => {
    const started = 1_000_000
    const now = started + PERMISSION_TIMEOUT_MS + 5_000
    expect(getPermissionRemainingMs({ requestedAt: started }, now)).toBe(0)
  })
})

describe('formatPermissionCountdown', () => {
  test('formats sub-minute seconds', () => {
    expect(formatPermissionCountdown(45_000)).toBe('剩余 45s')
  })

  test('formats minutes and seconds', () => {
    expect(formatPermissionCountdown(125_000)).toBe('剩余 2:05')
  })

  test('shows imminent when expired', () => {
    expect(formatPermissionCountdown(0)).toBe('即将超时')
  })
})

describe('buildPermissionTimeoutSessionError', () => {
  test('uses required timeout title', () => {
    const err = buildPermissionTimeoutSessionError('Write')
    expect(err.title).toBe('权限确认超时，已拒绝')
    expect(err.message).toContain('Write')
    expect(err.retryable).toBe(true)
    expect(err.code).toBe('permission_denied')
  })
})
