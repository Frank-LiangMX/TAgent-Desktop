import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { RoomBotSeat, RoomWorkspace } from '@tagent/shared'
import { decideRoomAccess, resolveBillingSubject } from '@tagent/core'
import { FileFusionRoomWorkspaceStore } from './fusion-room-workspace-store'
import { createFusionRoomTransportRuntime } from './fusion-room-runtime'

/**
 * P0-2 · 双用户 / 双 Bot owner / 共享工作区 HTTP·SSE fixture E2E
 *
 * 全程仅监听 127.0.0.1（port 0），复用 {@link createFusionRoomTransportRuntime}
 * 已经装好的 Host / Gateway / HTTP+SSE / 文件邀请 token store / 工作区 store，
 * 不打开打包版公网入口、不接真实账户 / OAuth / 证书 / 跨机器。
 *
 * 认证链与生产一致：`createFusionRoomInviteAuthenticator` 让 Bearer 邀请 token
 * 优先于 `x-user-id` 头；没有 token 时才回退到头。因此房主 A 走头，受邀用户 B
 * 走 Bearer token，且 B 即便伪造 `x-user-id` 头也无法借 token 变身。
 */

const workspace: RoomWorkspace = {
  id: 'rws_fixture',
  roomId: 'room-a',
  kind: 'server',
  storageKey: 'room-a',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
}

const runtimes: Array<ReturnType<typeof createFusionRoomTransportRuntime>> = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 鉴权方式：头（房主 / 成员）或 Bearer 邀请 token（受邀用户），可选伪造头证伪变身。 */
type Auth =
  | { kind: 'header'; userId: string }
  | { kind: 'token'; token: string; spoofUserId?: string }

function authHeaders(auth: Auth): Record<string, string> {
  if (auth.kind === 'header') return { 'x-user-id': auth.userId }
  const headers: Record<string, string> = { authorization: 'Bearer ' + auth.token }
  if (auth.spoofUserId) headers['x-user-id'] = auth.spoofUserId
  return headers
}

async function request(
  baseUrl: string,
  auth: Auth,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(baseUrl + path, {
    ...init,
    headers: {
      ...authHeaders(auth),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
}

async function requestJson(
  baseUrl: string,
  auth: Auth,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const response = await request(baseUrl, auth, path, init)
  return { status: response.status, body: await response.json() }
}

async function postAction(
  baseUrl: string,
  auth: Auth,
  roomId: string,
  action: unknown,
): Promise<{ status: number; body: any }> {
  return requestJson(baseUrl, auth, '/rooms/' + roomId + '/actions', {
    method: 'POST',
    body: JSON.stringify({ action }),
  })
}

function getSnapshot(baseUrl: string, auth: Auth, roomId: string): Promise<{ status: number; body: any }> {
  return requestJson(baseUrl, auth, '/rooms/' + roomId)
}

async function postInvite(
  baseUrl: string,
  auth: Auth,
  roomId: string,
  input: { userId: string; displayName: string },
): Promise<{ status: number; body: any }> {
  return requestJson(baseUrl, auth, '/rooms/' + roomId + '/invites', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

function makeSeat(opts: {
  id: string
  ownerUserId: string
  botProfileId?: string
  displayName?: string
}): RoomBotSeat {
  const id = opts.id
  return {
    id,
    roomId: 'room-a',
    botProfileId: opts.botProfileId ?? id,
    ownerUserId: opts.ownerUserId,
    configRevisionId: 'rev-' + id,
    displayNameSnapshot: opts.displayName ?? id,
    roleSnapshot: { displayName: opts.displayName ?? id },
    backend: 'pi',
    modelId: 'fixture-test-model',
    permissionProfile: 'read-only',
    capabilities: {
      supportsResume: false,
      supportsLiveInput: false,
      supportsToolBridge: false,
      supportsStructuredEvents: false,
    },
    status: 'idle',
    logicalSessionId: 'session-' + id,
    isCoordinator: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

interface Fixture {
  baseUrl: string
  runtime: ReturnType<typeof createFusionRoomTransportRuntime>
}

async function createFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'tagent-fusion-multiuser-'))
  tempDirs.push(dir)
  const runtime = createFusionRoomTransportRuntime({
    snapshotPath: join(dir, 'snapshots.json'),
    inviteTokenPath: join(dir, 'invite-tokens.json'),
    // 把物理工作区限定在临时目录，避免污染真实 collaboration room 工作区目录。
    workspaceStore: new FileFusionRoomWorkspaceStore({
      rootForRoom: (roomId) => join(dir, 'ws', roomId),
    }),
    authenticate: (request) => {
      const raw = request.headers['x-user-id']
      const userId = Array.isArray(raw) ? raw[0] : raw
      return userId ? { userId } : undefined
    },
  })
  runtimes.push(runtime)
  const address = await runtime.start({ host: '127.0.0.1', port: 0 })
  return { baseUrl: 'http://127.0.0.1:' + address.port, runtime }
}

/** 房主 A 建房 + 邀请 B + B 用 Bearer token 接受，返回 B 的 token。 */
async function bootstrapRoomAB(baseUrl: string): Promise<{ token: string; seatA: RoomBotSeat; seatB: RoomBotSeat }> {
  const owner = { kind: 'header', userId: 'user-a' } as const
  await requestJson(baseUrl, owner, '/rooms', {
    method: 'POST',
    body: JSON.stringify({ roomId: 'room-a', workspace }),
  })
  const invite = await postInvite(baseUrl, owner, 'room-a', { userId: 'user-b', displayName: 'B' })
  expect(invite.status).toBe(201)
  const token = invite.body.token as string
  expect(token).toMatch(/^frt1\./)

  const accepted = await postAction(baseUrl, { kind: 'token', token }, 'room-a', { type: 'accept-invitation' })
  expect(accepted.status).toBe(200)
  return { token, seatA: makeSeat({ id: 'seat-a', ownerUserId: 'user-a' }), seatB: makeSeat({ id: 'seat-b', ownerUserId: 'user-b' }) }
}

describe('multiuser fixture E2E (HTTP/SSE, loopback only)', () => {
  test('跨用户垂直切片：邀请 token 身份 / 双 Bot owner / consent / billing / 共享工作区', async () => {
    const { baseUrl } = await createFixture()
    const owner = { kind: 'header', userId: 'user-a' } as const
    const { token, seatA, seatB } = await bootstrapRoomAB(baseUrl)

    // 断言 #1：未邀请的 outsider 对 room-a 的 GET / actions 一律 403。
    const outsider = { kind: 'header', userId: 'outsider' } as const
    const outsiderSnapshot = await getSnapshot(baseUrl, outsider, 'room-a')
    expect(outsiderSnapshot.status).toBe(403)
    expect(outsiderSnapshot.body.error.code).toBe('FORBIDDEN')
    const outsiderAction = await postAction(baseUrl, outsider, 'room-a', {
      type: 'message',
      input: { content: 'outsider 不应能发言' },
    })
    expect(outsiderAction.status).toBe(403)
    expect(outsiderAction.body.error.code).toBe('FORBIDDEN')

    // 断言 #2a：B 用 Bearer token 接受邀请后成为 active 成员。
    const bSnapshot = await getSnapshot(baseUrl, { kind: 'token', token }, 'room-a')
    expect(bSnapshot.status).toBe(200)
    expect(
      bSnapshot.body.humanMembers.some((member: { userId: string; status: string }) => member.userId === 'user-b' && member.status === 'active'),
    ).toBe(true)

    // 断言 #2b：token 身份优先于随意头——B 带 Bearer token 同时伪造 `x-user-id: user-a`
    // 发消息，authorId 仍是 user-b，无法借 token 变身 A。
    const spoofed = await postAction(
      baseUrl,
      { kind: 'token', token, spoofUserId: 'user-a' },
      'room-a',
      { type: 'message', input: { content: '我其实还是 B', idempotencyKey: 'spoof-1' } },
    )
    expect(spoofed.status).toBe(200)
    expect(spoofed.body.snapshot.messages.at(-1).authorId).toBe('user-b')

    // 断言 #2c：绑定 room-a 的 token 不能进 room-b（principal.roomId 已由 invite store
    // 注入，decideRoomAccess 返回 SCOPE_MISMATCH；gateway 在 HTTP 层统一收口为 403）。
    await requestJson(baseUrl, owner, '/rooms', {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-b',
        workspace: { ...workspace, id: 'rws_b', roomId: 'room-b', storageKey: 'room-b' },
      }),
    })
    const crossRoom = await getSnapshot(baseUrl, { kind: 'token', token }, 'room-b')
    expect(crossRoom.status).toBe(403)
    const roomBSnapshot = await getSnapshot(baseUrl, owner, 'room-b')
    const scopeDecision = decideRoomAccess({
      principal: { userId: 'user-b', roomId: 'room-a' },
      roomId: 'room-b',
      ownerUserId: 'user-a',
      humanMembers: roomBSnapshot.body.humanMembers,
    })
    expect(scopeDecision.allowed).toBe(false)
    if (!scopeDecision.allowed) expect(scopeDecision.code).toBe('SCOPE_MISMATCH')

    // 断言 #3：A 加入自己的 Bot（owner=A），自动视为已 consent，可记 usage，费用主体=A。
    const addBotA = await postAction(baseUrl, owner, 'room-a', { type: 'add-bot', input: { seat: seatA } })
    expect(addBotA.status).toBe(200)
    expect(addBotA.body.snapshot.botOwnerConsents[seatA.id]).toBe(true)

    const usageA = await postAction(baseUrl, owner, 'room-a', {
      type: 'usage',
      input: { seatId: seatA.id, inputTokens: 11, outputTokens: 7, costMicros: 200, idempotencyKey: 'usage-a-1' },
    })
    expect(usageA.status).toBe(200)
    const usageEntryA = usageA.body.snapshot.usage.find((entry: { seatId: string }) => entry.seatId === seatA.id)
    expect(usageEntryA.botOwnerUserId).toBe('user-a')
    // 协议层旁路断言：费用主体恒为 Bot owner，不因发起人是房主而偷换。
    expect(resolveBillingSubject({ seatOwnerUserId: 'user-a', initiatedByUserId: 'user-a' }).billingUserId).toBe('user-a')

    // 断言 #4：A 代邀请 B 的 Bot（owner=B），不能自动视为已 consent（仅 pending）；
    // 在 B consent 前，针对该 seat 的 start-run / usage 被 canRun 以 CONSENT_REQUIRED 拒绝。
    const addBotB = await postAction(baseUrl, owner, 'room-a', { type: 'add-bot', input: { seat: seatB } })
    expect(addBotB.status).toBe(200)
    expect(addBotB.body.snapshot.botOwnerConsents[seatB.id]).toBe(false)

    const preConsentRun = await postAction(baseUrl, owner, 'room-a', {
      type: 'start-run',
      input: { seatId: seatB.id, backend: 'pi', idempotencyKey: 'run-b-pre' },
    })
    expect(preConsentRun.status).toBe(400)
    expect(preConsentRun.body.error.code).toBe('CONSENT_REQUIRED')

    const preConsentUsage = await postAction(baseUrl, owner, 'room-a', {
      type: 'usage',
      input: { seatId: seatB.id, inputTokens: 3, outputTokens: 1, costMicros: 10, idempotencyKey: 'usage-b-pre' },
    })
    expect(preConsentUsage.status).toBe(400)
    expect(preConsentUsage.body.error.code).toBe('CONSENT_REQUIRED')

    // 断言 #4b：A 不能代 B 签 consent——只有 Bot 所有人可以授权或撤回。
    const consentByA = await postAction(baseUrl, owner, 'room-a', { type: 'bot-consent', seatId: seatB.id, consent: true })
    expect(consentByA.status).toBe(403)
    expect(consentByA.body.error.code).toBe('FORBIDDEN')

    // 断言 #5：B 亲自 bot-consent 后，B 的 Bot 才可 start-run / usage，费用主体=B。
    const consentByB = await postAction(baseUrl, { kind: 'token', token }, 'room-a', { type: 'bot-consent', seatId: seatB.id, consent: true })
    expect(consentByB.status).toBe(200)
    expect(consentByB.body.snapshot.botOwnerConsents[seatB.id]).toBe(true)

    const runB = await postAction(baseUrl, owner, 'room-a', {
      type: 'start-run',
      input: { seatId: seatB.id, backend: 'pi', idempotencyKey: 'run-b-post' },
    })
    expect(runB.status).toBe(200)

    const usageB = await postAction(baseUrl, owner, 'room-a', {
      type: 'usage',
      input: { seatId: seatB.id, inputTokens: 29, outputTokens: 13, costMicros: 500, idempotencyKey: 'usage-b-post' },
    })
    expect(usageB.status).toBe(200)
    const usageEntryB = usageB.body.snapshot.usage.find((entry: { seatId: string }) => entry.seatId === seatB.id)
    expect(usageEntryB.botOwnerUserId).toBe('user-b')
    // 发起人仍是房主 A，但费用主体仍是 Bot owner B——不转移。
    expect(resolveBillingSubject({ seatOwnerUserId: 'user-b', initiatedByUserId: 'user-a' }).billingUserId).toBe('user-b')

    // 断言 #6：共享工作区——A 发布 downloadable 文件后 B 可下载到相同内容；
    // 非 downloadable 文件对 B 不可下载（统一 404，不泄露文件名 / 状态）。
    const lockRes = await postAction(baseUrl, owner, 'room-a', { type: 'lock', input: { relativePath: 'report.md', idempotencyKey: 'lock-report' } })
    expect(lockRes.status).toBe(200)
    const lockId = lockRes.body.result.id
    const commitReport = await postAction(baseUrl, owner, 'room-a', {
      type: 'commit-file',
      input: { lockId, relativePath: 'report.md', content: 'shared-report-body', downloadable: true, idempotencyKey: 'commit-report' },
    })
    expect(commitReport.status).toBe(200)
    expect(commitReport.body.snapshot.files.find((file: { relativePath: string }) => file.relativePath === 'report.md')?.downloadable).toBe(true)

    const downloadedByB = await request(baseUrl, { kind: 'token', token }, '/rooms/room-a/files?path=report.md')
    expect(downloadedByB.status).toBe(200)
    expect(await downloadedByB.text()).toBe('shared-report-body')
    expect(downloadedByB.headers.get('content-disposition')).toContain('report.md')

    // 非 downloadable 工作文件：即便 A 自己提交了内容，对 B（乃至任何人）都不可下载。
    const secretLockRes = await postAction(baseUrl, owner, 'room-a', { type: 'lock', input: { relativePath: 'secret.md', idempotencyKey: 'lock-secret' } })
    const secretCommit = await postAction(baseUrl, owner, 'room-a', {
      type: 'commit-file',
      input: { lockId: secretLockRes.body.result.id, relativePath: 'secret.md', content: 'private', idempotencyKey: 'commit-secret' },
    })
    expect(secretCommit.status).toBe(200)
    const hiddenByB = await request(baseUrl, { kind: 'token', token }, '/rooms/room-a/files?path=secret.md')
    expect(hiddenByB.status).toBe(404)
  })

  test('SSE：B 订阅后收到 A 侧动作产生的事件增量（加分项）', async () => {
    const { baseUrl } = await createFixture()
    const owner = { kind: 'header', userId: 'user-a' } as const
    const { token } = await bootstrapRoomAB(baseUrl)

    // B 用 Bearer token 订阅 SSE；首条是 snapshot 快照。
    const stream = await request(baseUrl, { kind: 'token', token }, '/rooms/room-a/events')
    expect(stream.status).toBe(200)
    const reader = stream.body?.getReader()
    if (!reader) throw new Error('SSE body 不可读')
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('type":"snapshot"')

    // A 发一条消息，B 应在 SSE 上读到对应的 message.appended 增量。
    const actionPromise = postAction(baseUrl, owner, 'room-a', {
      type: 'message',
      input: { content: 'A 侧动作', idempotencyKey: 'sse-message' },
    })
    const second = await reader.read()
    const secondText = new TextDecoder().decode(second.value)
    expect(secondText).toContain('message.appended')
    expect((await actionPromise).status).toBe(200)
    await reader.cancel()
  })
})
