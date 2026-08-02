import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tmpDir = ''
let rolesPath = ''
let configDir = ''

vi.mock('../config/config-paths', () => ({
  getAgentRolesPath: () => rolesPath,
  getConfigDir: () => configDir,
}))

vi.mock('../atomic-json', () => ({
  writeJsonAtomic: (path: string, data: unknown) => {
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  },
}))

const store = await import('./kanban-store')
const { DEFAULT_ROLES } = await import('@tagent/shared')

describe('kanban-store', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tagent-kanban-'))
    configDir = tmpDir
    rolesPath = join(tmpDir, 'agent-roles.json')
    writeFileSync(rolesPath, JSON.stringify(DEFAULT_ROLES, null, 2), 'utf-8')
    store.__resetKanbanStoreForTests()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('建板 + 建任务，默认 generalist', () => {
    const board = store.createBoard({ rootGoal: '实现登录' })
    expect(board.id).toMatch(/^b_/)
    expect(board.status).toBe('active')

    const task = store.createTask(
      {
        boardId: board.id,
        title: '写登录 API',
        body: '实现 JWT 登录',
        channelId: 'kscc-internal',
      },
      { availableModels: ['glm-5.2'] },
    )
    expect(task.roleId).toBe('generalist')
    expect(task.modelId).toBe('glm-5.2')
    expect(task.status).toBe('ready')
    expect(store.listTasksByBoard(board.id)).toHaveLength(1)
  })

  test('coder 角色绑定', () => {
    const board = store.createBoard({ rootGoal: '重构' })
    const task = store.createTask({
      boardId: board.id,
      title: '重构模块',
      channelId: 'ch1',
      roleId: 'coder',
      modelId: 'deepseek-v4-flash',
    })
    expect(task.roleId).toBe('coder')
    expect(task.modelId).toBe('deepseek-v4-flash')
    const preview = store.previewWorkerResolution(task, [])
    expect(preview.systemPrompt).toMatch(/后端|coder|架构/i)
  })

  test('dependsOn：前置未完成时 pending，done 后提升 ready', () => {
    const board = store.createBoard({ rootGoal: '依赖链' })
    const a = store.createTask({
      boardId: board.id,
      title: 'A',
      channelId: 'ch1',
      modelId: 'm1',
    })
    const b = store.createTask({
      boardId: board.id,
      title: 'B',
      channelId: 'ch1',
      modelId: 'm1',
      dependsOnTaskIds: [a.id],
    })
    expect(a.status).toBe('ready')
    expect(b.status).toBe('pending')
    expect(store.listBlockersOf(b.id)).toEqual([a.id])
    expect(store.listBlockedBy(a.id)).toEqual([b.id])

    store.updateTask(a.id, { status: 'done', resultSummary: 'A done', finishedAt: Date.now() })
    const promoted = store.promoteReadyDependents(a.id)
    expect(promoted).toHaveLength(1)
    expect(promoted[0]!.id).toBe(b.id)
    expect(store.getTask(b.id)!.status).toBe('ready')
  })

  test('多前置：全部 done 才提升', () => {
    const board = store.createBoard({ rootGoal: '多前置' })
    const a = store.createTask({
      boardId: board.id,
      title: 'A',
      channelId: 'ch1',
      modelId: 'm1',
    })
    const b = store.createTask({
      boardId: board.id,
      title: 'B',
      channelId: 'ch1',
      modelId: 'm1',
    })
    const c = store.createTask({
      boardId: board.id,
      title: 'C',
      channelId: 'ch1',
      modelId: 'm1',
      dependsOnTaskIds: [a.id, b.id],
    })
    expect(c.status).toBe('pending')
    store.updateTask(a.id, { status: 'done', finishedAt: Date.now() })
    expect(store.promoteReadyDependents(a.id)).toHaveLength(0)
    expect(store.getTask(c.id)!.status).toBe('pending')
    store.updateTask(b.id, { status: 'done', finishedAt: Date.now() })
    expect(store.promoteReadyDependents(b.id).map((t) => t.id)).toEqual([c.id])
    expect(store.getTask(c.id)!.status).toBe('ready')
  })

  test('unblock / retry', () => {
    const board = store.createBoard({ rootGoal: '重试' })
    const t = store.createTask({
      boardId: board.id,
      title: 'X',
      channelId: 'ch1',
      modelId: 'm1',
    })
    store.updateTask(t.id, { status: 'blocked', blockedReason: 'wait' })
    expect(store.unblockTask(t.id, 'user')!.status).toBe('ready')
    store.updateTask(t.id, { status: 'failed', error: 'boom' })
    expect(store.retryTask(t.id)!.status).toBe('ready')
  })
})
