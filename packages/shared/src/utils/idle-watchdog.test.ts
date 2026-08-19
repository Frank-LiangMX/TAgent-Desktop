import { describe, expect, test } from 'vitest'
import { shouldForceIdle, IDLE_WATCHDOG_TIMEOUT_MS } from './idle-watchdog'

describe('shouldForceIdle', () => {
  test('atom not running and no startedAt → never force idle', () => {
    expect(
      shouldForceIdle({
        lastStreamEventAt: null,
        now: 100_000,
        isMainProcessIdle: true,
        isAtomRunning: false,
      }),
    ).toBe(false)
  })

  test('soft-stop orphan: startedAt left + main idle + timeout → force idle', () => {
    const lastAt = 100_000
    expect(
      shouldForceIdle({
        lastStreamEventAt: lastAt,
        now: lastAt + IDLE_WATCHDOG_TIMEOUT_MS,
        isMainProcessIdle: true,
        isAtomRunning: false,
        hasStartedAt: true,
      }),
    ).toBe(true)
  })

  test('main process not idle → never force idle', () => {
    expect(
      shouldForceIdle({
        lastStreamEventAt: 50_000,
        now: 200_000,
        isMainProcessIdle: false,
        isAtomRunning: true,
      }),
    ).toBe(false)
  })

  test('atom running + main idle + no stream events → force idle immediately', () => {
    expect(
      shouldForceIdle({
        lastStreamEventAt: null,
        now: 100_000,
        isMainProcessIdle: true,
        isAtomRunning: true,
      }),
    ).toBe(true)
  })

  test('within timeout → do not force idle', () => {
    const lastAt = 100_000
    const now = lastAt + IDLE_WATCHDOG_TIMEOUT_MS - 1 // 1ms before timeout
    expect(
      shouldForceIdle({
        lastStreamEventAt: lastAt,
        now,
        isMainProcessIdle: true,
        isAtomRunning: true,
      }),
    ).toBe(false)
  })

  test('exactly at timeout → force idle', () => {
    const lastAt = 100_000
    const now = lastAt + IDLE_WATCHDOG_TIMEOUT_MS
    expect(
      shouldForceIdle({
        lastStreamEventAt: lastAt,
        now,
        isMainProcessIdle: true,
        isAtomRunning: true,
      }),
    ).toBe(true)
  })

  test('well past timeout → force idle', () => {
    const lastAt = 100_000
    const now = lastAt + IDLE_WATCHDOG_TIMEOUT_MS + 60_000
    expect(
      shouldForceIdle({
        lastStreamEventAt: lastAt,
        now,
        isMainProcessIdle: true,
        isAtomRunning: true,
      }),
    ).toBe(true)
  })

  test('main process not idle even if timeout → do not force idle', () => {
    const lastAt = 100_000
    const now = lastAt + IDLE_WATCHDOG_TIMEOUT_MS + 60_000
    expect(
      shouldForceIdle({
        lastStreamEventAt: lastAt,
        now,
        isMainProcessIdle: false,
        isAtomRunning: true,
      }),
    ).toBe(false)
  })

  test('awaiting user → never force idle（提交后要续原 startedAt）', () => {
    const lastAt = 100_000
    expect(
      shouldForceIdle({
        lastStreamEventAt: lastAt,
        now: lastAt + IDLE_WATCHDOG_TIMEOUT_MS + 60_000,
        isMainProcessIdle: true,
        isAtomRunning: false,
        hasStartedAt: true,
        awaitingUser: true,
      }),
    ).toBe(false)
  })

  test('atom already stopped even if timeout → do not force idle', () => {
    const lastAt = 100_000
    const now = lastAt + IDLE_WATCHDOG_TIMEOUT_MS + 60_000
    expect(
      shouldForceIdle({
        lastStreamEventAt: lastAt,
        now,
        isMainProcessIdle: true,
        isAtomRunning: false,
      }),
    ).toBe(false)
  })
})

describe('IDLE_WATCHDOG_TIMEOUT_MS', () => {
  test('is within 15–30s range', () => {
    expect(IDLE_WATCHDOG_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000)
    expect(IDLE_WATCHDOG_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })

  test('is 20s', () => {
    expect(IDLE_WATCHDOG_TIMEOUT_MS).toBe(20_000)
  })
})
