import { describe, expect, test, vi } from 'vitest'
import { createFusionRoomRemoteSession } from './fusion-room-remote-session'

describe('createFusionRoomRemoteSession', () => {
  test('is lazy and returns the client, adapter and controller boundary', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch
    const session = createFusionRoomRemoteSession({
      roomId: 'room_remote',
      baseUrl: 'http://127.0.0.1:4312',
      token: 'secret-token',
      fetch,
    })

    expect(fetch).not.toHaveBeenCalled()
    expect(session.client).toBeDefined()
    expect(session.adapter).toBeDefined()
    expect(session.controller.currentView).toBeUndefined()

    await session.close()
    await session.close()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('rejects blank or unsafe room session configuration without exposing token', () => {
    expect(() => createFusionRoomRemoteSession({ roomId: ' ', baseUrl: 'http://localhost' })).toThrow(/roomId/)
    expect(() => createFusionRoomRemoteSession({ roomId: '../secret', baseUrl: 'http://localhost' })).toThrow(/roomId/)
    expect(() => createFusionRoomRemoteSession({ roomId: 'room', baseUrl: '  ', token: 'never-log-me' })).toThrow(/baseUrl/)
  })

  test('rejects baseUrl that cannot be parsed as an absolute URL', () => {
    expect(() => createFusionRoomRemoteSession({ roomId: 'room', baseUrl: 'not a url' })).toThrow(/可解析/)
    expect(() => createFusionRoomRemoteSession({ roomId: 'room', baseUrl: '/relative/path' })).toThrow(/可解析/)
  })

  test('rejects baseUrl with a non-http(s) protocol', () => {
    expect(() => createFusionRoomRemoteSession({ roomId: 'room', baseUrl: 'file:///tmp' })).toThrow(/协议/)
    expect(() => createFusionRoomRemoteSession({ roomId: 'room', baseUrl: 'javascript:alert(1)' })).toThrow(/协议/)
  })

  test('rejects baseUrl that embeds username or password userinfo', () => {
    expect(() => createFusionRoomRemoteSession({ roomId: 'room', baseUrl: 'http://user:pass@example.com' })).toThrow(/用户名或密码/)
    expect(() => createFusionRoomRemoteSession({ roomId: 'room', baseUrl: 'https://alice@host' })).toThrow(/用户名或密码/)
  })
})
