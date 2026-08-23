import { describe, expect, it } from 'vitest'
import {
  FusionRoomHttpClient,
  FusionRoomHttpError,
} from './fusion-room-http-client'

describe('FusionRoomHttpClient', () => {
  it('uses bearer auth and exposes the RoomSession JSON endpoints', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const client = new FusionRoomHttpClient({
      baseUrl: 'http://room.test/',
      token: 'invite-token',
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        })
        const url = String(input)
        if (url.endsWith('/rooms')) {
          return new Response(JSON.stringify({ roomIds: ['room-a'] }), { status: 200 })
        }
        if (url.includes('/invites')) {
          return new Response(JSON.stringify({ token: 'frt1.token', tokenId: 'token', roomId: 'room-a', userId: 'user-b', displayName: 'B', createdAt: 1 }), { status: 201 })
        }
        if (url.includes('/files?path=')) return new Response('artifact', { status: 200 })
        return new Response(JSON.stringify({ roomId: 'room-a' }), { status: 200 })
      },
    })

    expect(await client.listRoomIds()).toEqual(['room-a'])
    expect(await client.getSnapshot('room-a')).toEqual({ roomId: 'room-a' })
    await client.createRoom({ roomId: 'room-a', workspace: { id: 'ws', name: 'Workspace', rootPath: 'room-a' } as never })
    await client.dispatch('room-a', { type: 'presence', status: 'active' })
    const invite = await client.issueInvite('room-a', { userId: 'user-b', displayName: 'B' })
    const downloaded = await client.downloadPublishedFile('room-a', 'notes.md')

    expect(invite.userId).toBe('user-b')
    expect(new TextDecoder().decode(downloaded)).toBe('artifact')
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST', 'POST', 'POST', 'GET'])
    expect(calls.every((call) => call.url.startsWith('http://room.test/'))).toBe(true)
    expect(calls.find((call) => call.body?.includes('presence'))?.body).toContain('presence')
  })

  it('parses snapshot, replay and live notification SSE envelopes with cursors', async () => {
    const payloads = [
      { type: 'snapshot', roomId: 'room-a', snapshot: { roomId: 'room-a' } },
      { type: 'replay', roomId: 'room-a', afterSequence: 2, events: [{ sequence: 3 }] },
      { roomId: 'room-a', connectionId: 'conn-1', events: [{ sequence: 4 }], snapshot: { roomId: 'room-a' } },
    ]
    const stream = payloads.map((payload, index) =>
      'id: ' + (index + 1) + '\n' +
      'event: room\n' +
      'data: ' + JSON.stringify(payload) + '\n\n',
    ).join('').replace(/\n\n$/, '\n')
    let requestHeaders: Headers | undefined
    const client = new FusionRoomHttpClient({
      baseUrl: 'http://room.test',
      fetch: async (_input, init) => {
        requestHeaders = new Headers(init?.headers)
        return new Response(stream, { status: 200 })
      },
    })
    const events: Array<{ kind: string; cursor?: number }> = []
    const subscription = await client.subscribe('room-a', {
      afterSequence: 2,
      onEvent: (event) => events.push({ kind: event.kind, cursor: event.cursor }),
    })
    await subscription.done

    expect(requestHeaders?.get('last-event-id')).toBe('2')
    expect(events).toEqual([
      { kind: 'snapshot', cursor: 1 },
      { kind: 'replay', cursor: 2 },
      { kind: 'notification', cursor: 3 },
    ])
  })

  it('maps structured HTTP errors and rejects invalid cursors', async () => {
    const client = new FusionRoomHttpClient({
      baseUrl: 'http://room.test',
      fetch: async () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: '拒绝' } }), { status: 403 }),
    })
    await expect(client.getSnapshot('room-a')).rejects.toEqual(
      new FusionRoomHttpError(403, 'FORBIDDEN', '拒绝'),
    )
    await expect(client.subscribe('room-a', { afterSequence: -1, onEvent: () => undefined })).rejects.toThrow('cursor')
  })
})
