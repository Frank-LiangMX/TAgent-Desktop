import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { FileFusionRoomInviteTokenStore } from './fusion-room-invite-token-store'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function createStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tagent-fusion-invite-'))
  dirs.push(dir)
  return new FileFusionRoomInviteTokenStore(join(dir, 'tokens.json'))
}

describe('FileFusionRoomInviteTokenStore', () => {
  test('签发的令牌可以恢复 principal，但磁盘不保存明文 secret', () => {
    const store = createStore()
    const invite = store.issue({
      roomId: 'room-1',
      userId: 'user-b',
      displayName: '用户 B',
      now: 100,
    })

    expect(invite.token).toMatch(/^frt1\.[a-f0-9]{24}\./)
    expect(store.authenticate(invite.token, 101)).toEqual({
      userId: 'user-b',
      kind: 'user',
      roomId: 'room-1',
    })
    const persisted = readFileSync(join(dirs[0]!, 'tokens.json'), 'utf8')
    expect(persisted).not.toContain(invite.token)
    expect(persisted).toContain(invite.tokenId)
  })

  test('令牌过期、撤销和重启读取都 fail-closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-fusion-invite-restart-'))
    dirs.push(dir)
    const path = join(dir, 'tokens.json')
    const first = new FileFusionRoomInviteTokenStore(path)
    const invite = first.issue({
      roomId: 'room-1',
      userId: 'user-b',
      displayName: 'B',
      expiresAt: 200,
      now: 100,
    })

    const second = new FileFusionRoomInviteTokenStore(path)
    expect(second.authenticate(invite.token, 199)?.userId).toBe('user-b')
    expect(second.authenticate(invite.token, 200)).toBeUndefined()
    expect(second.revoke(invite.tokenId, 150)).toBe(true)
    expect(second.authenticate(invite.token, 151)).toBeUndefined()
    expect(second.revoke(invite.tokenId, 152)).toBe(false)
  })

  test('可按房间撤销所有已签发邀请', () => {
    const store = createStore()
    store.issue({ roomId: 'room-1', userId: 'a', displayName: 'A', now: 1 })
    store.issue({ roomId: 'room-1', userId: 'b', displayName: 'B', now: 1 })
    const other = store.issue({ roomId: 'room-2', userId: 'c', displayName: 'C', now: 1 })

    expect(store.revokeRoom('room-1', 2)).toBe(2)
    expect(store.authenticate(other.token, 3)?.userId).toBe('c')
  })
})
