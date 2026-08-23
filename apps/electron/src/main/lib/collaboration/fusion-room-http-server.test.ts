import { afterEach, describe, expect, test } from 'vitest'
import type { RoomWorkspace } from '@tagent/shared'
import { FusionRoomGateway } from '@tagent/core'
import { FusionRoomHost } from '@tagent/core'
import { createFusionRoomHttpServer } from './fusion-room-http-server'

const workspace: RoomWorkspace = {
  id: 'rws_http',
  roomId: 'http-room',
  kind: 'server',
  storageKey: 'http-room',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
}

const servers: Array<ReturnType<typeof createFusionRoomHttpServer>> = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve()
            return
          }
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

async function createTestServer(
  options: {
    maxEventStreamsPerPrincipal?: number
    publishedFileReader?: { readFile(roomId: string, relativePath: string): string | undefined }
  } = {},
) {
  const host = new FusionRoomHost()
  const gateway = new FusionRoomGateway(host)
  const server = createFusionRoomHttpServer({
    gateway,
    authenticate: (request) => {
      const raw = request.headers['x-user-id']
      const userId = Array.isArray(raw) ? raw[0] : raw
      return userId ? { userId } : undefined
    },
    ...(options.maxEventStreamsPerPrincipal !== undefined
      ? { maxEventStreamsPerPrincipal: options.maxEventStreamsPerPrincipal }
      : {}),
    ...(options.publishedFileReader ? { publishedFileReader: options.publishedFileReader } : {}),
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试 HTTP server 没有监听端口')
  return { server, baseUrl: 'http://127.0.0.1:' + address.port }
}

async function requestJson(
  baseUrl: string,
  userId: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(baseUrl + path, {
    ...init,
    headers: {
      'x-user-id': userId,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  return { status: response.status, body: await response.json() }
}

describe('FusionRoom HTTP/SSE transport', () => {
  test('通过 HTTP 创建、邀请、发消息，并拒绝未授权用户', async () => {
    const { baseUrl } = await createTestServer()
    const created = await requestJson(baseUrl, 'owner', '/rooms', {
      method: 'POST',
      body: JSON.stringify({ roomId: 'http-room', workspace }),
    })
    expect(created.status).toBe(201)

    const listed = await requestJson(baseUrl, 'owner', '/rooms')
    expect(listed.body.roomIds).toEqual(['http-room'])

    const invited = await requestJson(baseUrl, 'owner', '/rooms/http-room/actions', {
      method: 'POST',
      body: JSON.stringify({
        action: { type: 'invite-human', userId: 'user-b', displayName: 'B' },
      }),
    })
    expect(invited.status).toBe(200)

    const accepted = await requestJson(baseUrl, 'user-b', '/rooms/http-room/actions', {
      method: 'POST',
      body: JSON.stringify({ action: { type: 'accept-invitation' } }),
    })
    expect(accepted.status).toBe(200)

    const message = await requestJson(baseUrl, 'user-b', '/rooms/http-room/actions', {
      method: 'POST',
      body: JSON.stringify({
        action: {
          type: 'message',
          input: { content: '来自 B', actorUserId: 'owner' },
        },
      }),
    })
    expect(message.status).toBe(200)
    expect(message.body.snapshot.messages[0].authorId).toBe('user-b')

    const denied = await requestJson(baseUrl, 'outsider', '/rooms/http-room')
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('FORBIDDEN')
  })

  test('只允许下载权威快照明确发布的文件', async () => {
    const { baseUrl } = await createTestServer({
      publishedFileReader: {
        readFile: (_roomId, relativePath) => (relativePath === 'notes.md' ? 'published' : undefined),
      },
    })
    await requestJson(baseUrl, 'owner', '/rooms', {
      method: 'POST',
      body: JSON.stringify({ roomId: 'http-room', workspace }),
    })
    const lock = await requestJson(baseUrl, 'owner', '/rooms/http-room/actions', {
      method: 'POST',
      body: JSON.stringify({
        action: { type: 'lock', input: { relativePath: 'notes.md' } },
      }),
    })
    const lockId = lock.body.result.id
    const committed = await requestJson(baseUrl, 'owner', '/rooms/http-room/actions', {
      method: 'POST',
      body: JSON.stringify({
        action: {
          type: 'commit-file',
          input: { lockId, relativePath: 'notes.md', content: 'published', downloadable: true },
        },
      }),
    })
    expect(committed.status).toBe(200)

    const downloaded = await fetch(baseUrl + '/rooms/http-room/files?path=notes.md', {
      headers: { 'x-user-id': 'owner' },
    })
    expect(downloaded.status).toBe(200)
    expect(await downloaded.text()).toBe('published')
    expect(downloaded.headers.get('content-disposition')).toContain('notes.md')

    const hiddenLock = await requestJson(baseUrl, 'owner', '/rooms/http-room/actions', {
      method: 'POST',
      body: JSON.stringify({
        action: { type: 'lock', input: { relativePath: 'private.md' } },
      }),
    })
    await requestJson(baseUrl, 'owner', '/rooms/http-room/actions', {
      method: 'POST',
      body: JSON.stringify({
        action: {
          type: 'commit-file',
          input: { lockId: hiddenLock.body.result.id, relativePath: 'private.md', content: 'private' },
        },
      }),
    })
    const hidden = await fetch(baseUrl + '/rooms/http-room/files?path=private.md', {
      headers: { 'x-user-id': 'owner' },
    })
    expect(hidden.status).toBe(404)
  })

  test('限制同一用户的 SSE 连接数', async () => {
    const { baseUrl } = await createTestServer({ maxEventStreamsPerPrincipal: 1 })
    await requestJson(baseUrl, 'owner', '/rooms', {
      method: 'POST',
      body: JSON.stringify({ roomId: 'http-room', workspace }),
    })

    const first = await fetch(baseUrl + '/rooms/http-room/events', {
      headers: { 'x-user-id': 'owner' },
    })
    expect(first.status).toBe(200)
    const firstReader = first.body?.getReader()
    await firstReader?.read()

    const second = await fetch(baseUrl + '/rooms/http-room/events', {
      headers: { 'x-user-id': 'owner' },
    })
    expect(second.status).toBe(429)
    await firstReader?.cancel()
  })

  test('失败的 SSE 建连不会占用后续连接配额', async () => {
    const { baseUrl } = await createTestServer({ maxEventStreamsPerPrincipal: 1 })
    const missing = await requestJson(baseUrl, 'owner', '/rooms/missing/events')
    expect(missing.status).toBe(404)

    await requestJson(baseUrl, 'owner', '/rooms', {
      method: 'POST',
      body: JSON.stringify({ roomId: 'http-room', workspace }),
    })
    const stream = await fetch(baseUrl + '/rooms/http-room/events', {
      headers: { 'x-user-id': 'owner' },
    })
    expect(stream.status).toBe(200)
    const reader = stream.body?.getReader()
    await reader?.read()
    await reader?.cancel()
  })

  test('SSE 先推送快照，再推送 RoomEvent', async () => {
    const { baseUrl } = await createTestServer()
    await requestJson(baseUrl, 'owner', '/rooms', {
      method: 'POST',
      body: JSON.stringify({ roomId: 'http-room', workspace }),
    })

    const stream = await fetch(baseUrl + '/rooms/http-room/events', {
      headers: { 'x-user-id': 'owner' },
    })
    expect(stream.status).toBe(200)
    const reader = stream.body?.getReader()
    if (!reader) throw new Error('SSE body 不可读')

    const first = await reader.read()
    const firstText = new TextDecoder().decode(first.value)
    expect(firstText).toContain('type":"snapshot"')

    const actionPromise = requestJson(baseUrl, 'owner', '/rooms/http-room/actions', {
      method: 'POST',
      body: JSON.stringify({ action: { type: 'status', status: 'paused' } }),
    })
    const second = await reader.read()
    const secondText = new TextDecoder().decode(second.value)
    expect(secondText).toContain('room.updated')
    expect((await actionPromise).status).toBe(200)
    await reader.cancel()
  })

  test('SSE 使用 after cursor 重放事件并携带可续接的 SSE id', async () => {
    const { baseUrl } = await createTestServer()
    await requestJson(baseUrl, 'owner', '/rooms', {
      method: 'POST',
      body: JSON.stringify({ roomId: 'http-room', workspace }),
    })
    await requestJson(baseUrl, 'owner', '/rooms/http-room/actions', {
      method: 'POST',
      body: JSON.stringify({
        action: { type: 'message', input: { content: '断线前消息', idempotencyKey: 'replay-message' } },
      }),
    })

    const stream = await fetch(baseUrl + '/rooms/http-room/events?after=1', {
      headers: { 'x-user-id': 'owner' },
    })
    expect(stream.status).toBe(200)
    const reader = stream.body?.getReader()
    if (!reader) throw new Error('SSE body 不可读')
    const first = await reader.read()
    const firstText = new TextDecoder().decode(first.value)
    expect(firstText).toContain('id: 2')
    expect(firstText).toContain('type":"replay"')
    expect(firstText).toContain('afterSequence":1')
    expect(firstText).toContain('message.appended')
    await reader.cancel()

    const invalid = await requestJson(baseUrl, 'owner', '/rooms/http-room/events?after=nope')
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('INVALID_STATE')
  })})
