import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tmpDir = ''
let rolesPath = ''
let configDir = ''
const metas = new Map<string, { id: string; executionMode?: string }>()

vi.mock('../config/config-paths', () => ({
  getAgentRolesPath: () => rolesPath,
  getConfigDir: () => configDir,
}))

vi.mock('../atomic-json', () => ({
  writeJsonAtomic: (path: string, data: unknown) => {
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  },
}))

vi.mock('../agent/session-store', () => ({
  getSessionMeta: (id: string) => metas.get(id),
}))

// avoid starting real timer from kick
vi.mock('./kanban-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kanban-dispatcher')>()
  return {
    ...actual,
    kickKanbanDispatcher: () => {},
  }
})

const tools = await import('./kanban-agent-tools')
const store = await import('./kanban-store')
const { DEFAULT_ROLES } = await import('@tagent/shared')

describe('kanban-agent-tools', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tagent-ktools-'))
    configDir = tmpDir
    rolesPath = join(tmpDir, 'agent-roles.json')
    writeFileSync(rolesPath, JSON.stringify(DEFAULT_ROLES, null, 2), 'utf-8')
    store.__resetKanbanStoreForTests()
    metas.clear()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('Chat 下 create_board 拒绝', async () => {
    metas.set('s-chat', { id: 's-chat', executionMode: 'chat' })
    const res = await tools.handleCreateBoard(
      { rootGoal: '做个登录' },
      { sessionId: 's-chat' },
    )
    expect(res.content[0]!.text).toMatch(/Chat/)
  })

  test('Work 下 create + add + list', async () => {
    metas.set('s-work', { id: 's-work', executionMode: 'work' })
    const created = await tools.handleCreateBoard(
      { rootGoal: '实现 API' },
      { sessionId: 's-work', channelId: 'ch1' },
    )
    const boardJson = JSON.parse(created.content[0]!.text)
    expect(boardJson.ok).toBe(true)
    expect(boardJson.boardId).toMatch(/^b_/)

    const added = await tools.handleAddTask(
      {
        boardId: boardJson.boardId,
        title: '写接口',
        roleId: 'coder',
        channelId: 'ch1',
      },
      { sessionId: 's-work', channelId: 'ch1' },
    )
    const taskJson = JSON.parse(added.content[0]!.text)
    expect(taskJson.ok).toBe(true)
    expect(taskJson.roleId).toBe('coder')

    const listed = await tools.handleListTasks({ boardId: boardJson.boardId })
    const listJson = JSON.parse(listed.content[0]!.text)
    expect(listJson.count).toBe(1)
  })

  test('buildPiKanbanTools full 含 create', () => {
    const list = tools.buildPiKanbanTools({
      sessionId: 's',
      toolMode: 'full',
    })
    const names = list.map((t) => t.name)
    expect(names).toContain('kanban_create_board')
    expect(names).toContain('kanban_add_task')
    expect(names).toContain('kanban_list_tasks')
  })

  test('buildPiKanbanTools worker 无 create', () => {
    const list = tools.buildPiKanbanTools({
      sessionId: 's',
      toolMode: 'worker',
    })
    const names = list.map((t) => t.name)
    expect(names).not.toContain('kanban_create_board')
    expect(names).toContain('kanban_complete')
  })
})
