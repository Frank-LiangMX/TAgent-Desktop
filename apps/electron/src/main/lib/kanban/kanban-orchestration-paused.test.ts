import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CREW_ORCHESTRATION_ENABLED,
  CREW_PAUSED_MESSAGE,
  KANBAN_IPC_CHANNELS,
} from '@tagent/shared'

const testState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => testState.handlers.set(name, handler),
  },
}))

vi.mock('../agent/session-store', () => ({
  getSessionMeta: (id: string) => id === 'work-session'
    ? { id, executionMode: 'work' }
    : undefined,
}))

// Set the complete test config root before any kanban module is imported. If a
// future gate regresses, store writes/scans still remain inside this temp dir.
const tempConfigDir = mkdtempSync(join(tmpdir(), 'tagent-crew-paused-'))
const previousConfigDir = process.env.TAGENT_CONFIG_DIR
process.env.TAGENT_CONFIG_DIR = tempConfigDir

const { handleAddTask, handleCreateBoard, buildPiKanbanTools, injectKanbanMcpServer } =
  await import('./kanban-agent-tools')
const { assertKanbanWriteAllowed } = await import('./work-mode-guard')
const dispatcher = await import('./kanban-dispatcher')
const { bootstrapKanban } = await import('./kanban-bootstrap')
const store = await import('./kanban-store')

beforeAll(() => {
  process.env.TAGENT_CONFIG_DIR = tempConfigDir
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.TAGENT_CONFIG_DIR
  else process.env.TAGENT_CONFIG_DIR = previousConfigDir
  rmSync(tempConfigDir, { recursive: true, force: true })
})

describe('crew orchestration product pause', () => {
  test('默认关闭，agent mutations are rejected and Pi/MCP orchestration tools are absent', async () => {
    expect(CREW_ORCHESTRATION_ENABLED).toBe(false)
    expect(assertKanbanWriteAllowed('work-session')).toMatchObject({
      ok: false,
      error: CREW_PAUSED_MESSAGE,
    })

    const create = await handleCreateBoard(
      { rootGoal: '不会写入' },
      { sessionId: 'work-session' },
    )
    expect(create.content[0]?.text).toContain(CREW_PAUSED_MESSAGE)

    const add = await handleAddTask(
      { boardId: 'old-board', title: '不会入队', channelId: 'old-channel' },
      { sessionId: 'work-session' },
    )
    expect(add.content[0]?.text).toContain(CREW_PAUSED_MESSAGE)
    expect(buildPiKanbanTools({ sessionId: 'work-session' })).toEqual([])

    const mcpServers: Record<string, unknown> = {}
    await injectKanbanMcpServer(mcpServers, { sessionId: 'work-session' })
    expect(mcpServers).toEqual({})
  })

  test('默认关闭时 dispatcher 不启动、不 kick、不执行旧 ready 队列', async () => {
    const board = store.createBoard({ rootGoal: '重启后不应自动执行' })
    const task = store.createTask({
      boardId: board.id,
      title: '旧 ready 任务',
      channelId: 'old-channel',
      modelId: 'old-model',
    })
    const before = { board: store.getBoard(board.id), task: store.getTask(task.id) }
    const runner = vi.fn(async () => ({ finalStatus: 'done' as const }))
    dispatcher.configureKanbanDispatcher({ runner })
    bootstrapKanban(() => null)
    dispatcher.startKanbanDispatcher()
    dispatcher.kickKanbanDispatcher()
    dispatcher.dispatchKanbanTick()
    await Promise.resolve()
    expect(runner).not.toHaveBeenCalled()
    expect(store.getBoard(board.id)).toEqual(before.board)
    expect(store.getTask(task.id)).toEqual(before.task)
    expect(store.getTask(task.id)?.status).toBe('ready')
    dispatcher.stopKanbanDispatcher()
  })

  test('IPC mutation handlers return paused message before legacy store mutation', async () => {
    const { registerKanbanIpc } = await import('./kanban-ipc')
    registerKanbanIpc()

    const invoke = async (name: string, input: unknown) =>
      testState.handlers.get(name)?.({}, input)
    for (const [name, input] of [
      [KANBAN_IPC_CHANNELS.CREATE_BOARD, { rootGoal: 'blocked', sessionId: 'work-session' }],
      [KANBAN_IPC_CHANNELS.CREATE_TASK, { boardId: 'b', title: 'blocked', channelId: 'c', sessionId: 'work-session' }],
      [KANBAN_IPC_CHANNELS.RESUME_BOARD, { boardId: 'b', sessionId: 'work-session' }],
      [KANBAN_IPC_CHANNELS.UNBLOCK_TASK, { taskId: 't' }],
      [KANBAN_IPC_CHANNELS.RETRY_TASK, { taskId: 't' }],
      [KANBAN_IPC_CHANNELS.COMMENT_TASK, { taskId: 't', comment: 'blocked' }],
    ] as const) {
      await expect(invoke(name, input)).resolves.toMatchObject({
        ok: false,
        error: CREW_PAUSED_MESSAGE,
      })
    }

    const board = store.createBoard({ rootGoal: '可停止但不派发', parentSessionId: 'work-session' })
    const task = store.createTask({
      boardId: board.id,
      title: '历史任务仍可读取',
      channelId: 'old-channel',
      modelId: 'old-model',
    })
    await expect(invoke(KANBAN_IPC_CHANNELS.LIST_BOARDS, { status: 'active' })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: board.id })]),
    )
    await expect(invoke(KANBAN_IPC_CHANNELS.GET_BOARD, board.id)).resolves.toMatchObject({
      id: board.id,
      rootGoal: '可停止但不派发',
    })
    await expect(invoke(KANBAN_IPC_CHANNELS.LIST_TASKS, { boardId: board.id })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: task.id, status: 'ready' })]),
    )
    await expect(invoke(KANBAN_IPC_CHANNELS.GET_TASK, task.id)).resolves.toMatchObject({
      id: task.id,
      title: '历史任务仍可读取',
      status: 'ready',
    })
    await expect(invoke(KANBAN_IPC_CHANNELS.PAUSE_BOARD, {
      boardId: board.id,
      sessionId: 'work-session',
    })).resolves.toMatchObject({ ok: true, board: { paused: true } })
  })
})
