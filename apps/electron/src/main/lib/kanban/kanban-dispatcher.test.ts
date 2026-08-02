import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const dispatcher = await import('./kanban-dispatcher')
const { DEFAULT_ROLES } = await import('@tagent/shared')

describe('kanban-dispatcher', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tagent-disp-'))
    configDir = tmpDir
    rolesPath = join(tmpDir, 'agent-roles.json')
    writeFileSync(rolesPath, JSON.stringify(DEFAULT_ROLES, null, 2), 'utf-8')
    store.__resetKanbanStoreForTests()
    dispatcher.__resetDispatcherStateForTests()
  })

  afterEach(() => {
    dispatcher.__resetDispatcherStateForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('tick 派工 stub 工人后任务 done', async () => {
    const board = store.createBoard({ rootGoal: '测调度' })
    store.createTask(
      {
        boardId: board.id,
        title: '任务 A',
        channelId: 'ch1',
        modelId: 'm1',
      },
      { availableModels: ['m1'] },
    )

    const statuses: string[] = []
    dispatcher.configureKanbanDispatcher({
      runner: async (task) => {
        expect(task.status).toBe('running')
        return { summary: `ok:${task.title}`, finalStatus: 'done' }
      },
      getAvailableModels: () => ['m1'],
      onTaskStatusChanged: (_id, s) => {
        statuses.push(s)
      },
    })

    dispatcher.dispatchKanbanTick()
    // 等 worker 异步结束
    await new Promise((r) => setTimeout(r, 50))
    // 再等 finally 里的二次 tick
    await new Promise((r) => setTimeout(r, 30))

    const tasks = store.listTasksByBoard(board.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.status).toBe('done')
    expect(tasks[0]!.resultSummary).toContain('ok:任务 A')
    expect(statuses).toContain('running')
    expect(statuses).toContain('done')
  })

  test('maxConcurrent=1 时第二任务等待', async () => {
    const board = store.createBoard({ rootGoal: '并发', maxConcurrent: 1 })
    store.createTask({
      boardId: board.id,
      title: '慢任务',
      channelId: 'ch1',
      modelId: 'm1',
    })
    store.createTask({
      boardId: board.id,
      title: '排队',
      channelId: 'ch1',
      modelId: 'm1',
    })

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    dispatcher.configureKanbanDispatcher({
      runner: async (task) => {
        if (task.title === '慢任务') await gate
        return { summary: task.title, finalStatus: 'done' }
      },
      getAvailableModels: () => ['m1'],
    })

    dispatcher.dispatchKanbanTick()
    await new Promise((r) => setTimeout(r, 20))

    const mid = store.listTasksByBoard(board.id)
    const running = mid.filter((t) => t.status === 'running')
    const ready = mid.filter((t) => t.status === 'ready')
    expect(running).toHaveLength(1)
    expect(running[0]!.title).toBe('慢任务')
    expect(ready).toHaveLength(1)

    release()
    // worker finally → queueMicrotask tick → 第二任务 → 再 await runner
    await new Promise((r) => setTimeout(r, 150))

    const end = store.listTasksByBoard(board.id)
    expect(end.map((t) => t.status).sort()).toEqual(['done', 'done'])
  })

  test('依赖：A blocks B → 仅 A 先跑，A done 后 B 才 ready 并执行', async () => {
    const board = store.createBoard({ rootGoal: '依赖链', maxConcurrent: 3 })
    const a = store.createTask({
      boardId: board.id,
      title: '任务A',
      channelId: 'ch1',
      modelId: 'm1',
    })
    const b = store.createTask({
      boardId: board.id,
      title: '任务B',
      channelId: 'ch1',
      modelId: 'm1',
      dependsOnTaskIds: [a.id],
    })
    expect(store.getTask(b.id)!.status).toBe('pending')

    const runOrder: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => {
      releaseA = r
    })

    dispatcher.configureKanbanDispatcher({
      runner: async (task) => {
        runOrder.push(task.title)
        if (task.title === '任务A') await gateA
        return {
          summary: `完成 ${task.title} 的可验收交付说明文字足够长`,
          finalStatus: 'done',
        }
      },
      getAvailableModels: () => ['m1'],
    })

    dispatcher.dispatchKanbanTick()
    await new Promise((r) => setTimeout(r, 40))

    // A running，B 仍 pending（未 promote）
    expect(store.getTask(a.id)!.status).toBe('running')
    expect(store.getTask(b.id)!.status).toBe('pending')
    expect(runOrder).toEqual(['任务A'])

    releaseA()
    await new Promise((r) => setTimeout(r, 150))

    expect(store.getTask(a.id)!.status).toBe('done')
    expect(store.getTask(b.id)!.status).toBe('done')
    expect(runOrder).toEqual(['任务A', '任务B'])
  })
})
