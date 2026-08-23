import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { RoomWorkspace } from '@tagent/shared'
import { FusionRoomHost, FusionRoomSnapshotConflictError } from '@tagent/core'
import { FileFusionRoomSnapshotStore } from './fusion-room-snapshot-store'

const dirs: string[] = []
const workspace: RoomWorkspace = {
  id: 'rws_file_store',
  roomId: 'file-store-room',
  kind: 'server',
  storageKey: 'file-store-room',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('FileFusionRoomSnapshotStore', () => {
  test('多 Host 对同一房间的旧快照写入会被事件版本保护拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-fusion-snapshot-cas-'))
    dirs.push(dir)
    const path = join(dir, 'snapshots.json')
    const first = new FusionRoomHost({
      snapshotStore: new FileFusionRoomSnapshotStore(path),
    })
    first.createRoom({
      roomId: 'cas-room',
      ownerUserId: 'owner',
      workspace: { ...workspace, id: 'rws_cas', roomId: 'cas-room', storageKey: 'cas-room' },
    })

    const second = new FusionRoomHost({
      snapshotStore: new FileFusionRoomSnapshotStore(path),
    })
    expect(second.getSnapshot('cas-room').events).toHaveLength(1)
    expect(() => second.createRoom({
      roomId: 'cas-room',
      ownerUserId: 'owner',
      workspace: { ...workspace, id: 'rws_cas_duplicate', roomId: 'cas-room', storageKey: 'cas-room' },
    })).toThrow(/RoomSession 已存在/)

    first.dispatch('cas-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '来自第一个 Host', idempotencyKey: 'cas-1' },
    })
    expect(() => second.dispatch('cas-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '旧 Host 覆盖', idempotencyKey: 'cas-2' },
    })).toThrow(FusionRoomSnapshotConflictError)

    const persisted = new FileFusionRoomSnapshotStore(path).load('cas-room')
    expect(persisted?.messages.map((message) => message.content)).toEqual(['来自第一个 Host'])

    const reloaded = new FusionRoomHost({
      snapshotStore: new FileFusionRoomSnapshotStore(path),
    })
    reloaded.dispatch('cas-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '重新加载后继续', idempotencyKey: 'cas-2' },
    })
    expect(reloaded.getSnapshot('cas-room').messages.map((message) => message.content)).toEqual([
      '来自第一个 Host',
      '重新加载后继续',
    ])
  })
  test('原子 JSON 快照支持新的 Host 重启恢复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-fusion-snapshot-'))
    dirs.push(dir)
    const path = join(dir, 'snapshots.json')
    const store = new FileFusionRoomSnapshotStore(path)
    const host = new FusionRoomHost({ snapshotStore: store })
    host.createRoom({
      roomId: 'file-store-room',
      ownerUserId: 'owner',
      workspace,
      now: 1,
    })
    host.dispatch('file-store-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: 'persisted' },
    })

    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      snapshots: Record<string, unknown>
    }
    expect(raw.version).toBe(1)
    expect(Object.keys(raw.snapshots)).toEqual(['file-store-room'])

    const restarted = new FusionRoomHost({
      snapshotStore: new FileFusionRoomSnapshotStore(path),
    })
    expect(restarted.listRoomIds()).toEqual(['file-store-room'])
    expect(restarted.getSnapshot('file-store-room').messages[0]?.content).toBe('persisted')
  })
})
