import { afterEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileFusionRoomWorkspaceStore } from './fusion-room-workspace-store'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createStore(maxFileBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), 'tagent-fusion-workspace-'))
  roots.push(root)
  return {
    root,
    store: new FileFusionRoomWorkspaceStore({
      rootForRoom: (roomId) => join(root, roomId),
      ...(maxFileBytes !== undefined ? { maxFileBytes } : {}),
    }),
  }
}

describe('FileFusionRoomWorkspaceStore', () => {
  test('先写临时文件，commit 原子替换，rollback 恢复旧版本', () => {
    const { root, store } = createStore()
    const first = store.prepareCommit({ roomId: 'room-a', relativePath: 'docs/readme.md', content: 'v1' })
    first.commit()
    const target = join(root, 'room-a', 'docs', 'readme.md')
    expect(readFileSync(target, 'utf8')).toBe('v1')

    const second = store.prepareCommit({ roomId: 'room-a', relativePath: 'docs/readme.md', content: 'v2' })
    second.commit()
    expect(readFileSync(target, 'utf8')).toBe('v2')
    second.rollback()
    expect(readFileSync(target, 'utf8')).toBe('v1')
  })

  test('未提交事务 rollback 不留下半成品', () => {
    const { root, store } = createStore()
    const transaction = store.prepareCommit({ roomId: 'room-a', relativePath: 'new.txt', content: 'new' })
    transaction.rollback()
    expect(existsSync(join(root, 'room-a', 'new.txt'))).toBe(false)
    expect(store.readFile('room-a', 'new.txt')).toBeUndefined()
  })

  test('符号链接在读取旧内容前就被拒绝', () => {
    const { root, store } = createStore()
    const roomRoot = join(root, 'room-a')
    const outside = join(root, 'outside.txt')
    mkdirSync(roomRoot, { recursive: true })
    writeFileSync(outside, 'outside', 'utf8')
    const link = join(roomRoot, 'link.txt')
    try {
      symlinkSync(outside, link, 'file')
    } catch {
      // Windows 未开启开发者模式时可能没有创建符号链接的权限。
      return
    }
    expect(() =>
      store.prepareCommit({ roomId: 'room-a', relativePath: 'link.txt', content: 'blocked' }),
    ).toThrow('符号链接')
    expect(() => store.readFile('room-a', 'link.txt')).toThrow('符号链接')
  })

  test('拒绝越界、反斜杠和超大文件', () => {
    const { store } = createStore(3)
    expect(() => store.prepareCommit({ roomId: 'room-a', relativePath: '../escape.txt', content: 'x' })).toThrow()
    expect(() => store.prepareCommit({ roomId: 'room-a', relativePath: 'nested\\escape.txt', content: 'x' })).toThrow()
    expect(() => store.prepareCommit({ roomId: 'room-a', relativePath: 'large.txt', content: '1234' })).toThrow()
  })

  test('搜索和白名单命令都限制在房间工作区内', async () => {
    const { store } = createStore()
    const transaction = store.prepareCommit({ roomId: 'room-a', relativePath: 'src/app.ts', content: 'export const answer = 42' })
    transaction.commit()
    const search = store.searchFiles('room-a', '.', '*.ts')
    expect(search.paths).toEqual(['src/app.ts'])
    const command = await store.runCommand?.({
      roomId: 'room-a',
      command: 'node',
      args: '["-e","console.log(1)"]',
    })
    expect(command?.ok).toBe(true)
    if (command?.ok) expect(command.stdout.trim()).toBe('1')
  })

  test('删除和移动事务可提交并安全回滚移动', () => {
    const { root, store } = createStore()
    const created = store.prepareCommit({ roomId: 'room-a', relativePath: 'src/old.ts', content: 'content' })
    created.commit()
    const move = store.prepareMove({ roomId: 'room-a', fromPath: 'src/old.ts', toPath: 'src/new.ts' })
    move.commit()
    expect(existsSync(join(root, 'room-a', 'src', 'old.ts'))).toBe(false)
    expect(readFileSync(join(root, 'room-a', 'src', 'new.ts'), 'utf8')).toBe('content')
    move.rollback()
    expect(readFileSync(join(root, 'room-a', 'src', 'old.ts'), 'utf8')).toBe('content')
    expect(existsSync(join(root, 'room-a', 'src', 'new.ts'))).toBe(false)
    const remove = store.prepareDelete({ roomId: 'room-a', relativePath: 'src/old.ts' })
    remove.commit()
    expect(store.readFile('room-a', 'src/old.ts')).toBeUndefined()
  })})
