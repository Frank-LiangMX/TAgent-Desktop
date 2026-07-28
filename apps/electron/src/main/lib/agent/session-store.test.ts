import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SDKMessage } from '@tagent/shared'

vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

let configDir: string

async function loadStore() {
  vi.resetModules()
  return import('./session-store')
}

function userMessage(text: string): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'tagent-session-store-'))
  process.env.TAGENT_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(configDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('session-store persistence smoke', () => {
  it('persists workspace-bound metadata and messages across module reloads', async () => {
    const store = await loadStore()
    const created = store.createSession({
      id: 'session-smoke',
      title: '持久化冒烟',
      channelId: 'channel-1',
      modelId: 'model-1',
      workspaceId: 'F--project-smoke',
      turnCount: 1,
    })
    store.appendMessages(created.workspaceId, created.id, [
      userMessage('第一条'),
      userMessage('第二条'),
    ])
    store.updateSessionMeta(created.id, { pinned: true, turnCount: 2 })

    const reloaded = await loadStore()
    const meta = reloaded.getSessionMeta(created.id)
    const messages = reloaded.readMessages(created.workspaceId, created.id)

    expect(meta).toMatchObject({
      id: 'session-smoke',
      title: '持久化冒烟',
      channelId: 'channel-1',
      modelId: 'model-1',
      workspaceId: 'F--project-smoke',
      turnCount: 2,
      pinned: true,
    })
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      type: 'user',
      message: { role: 'user' },
    })
    expect(
      existsSync(
        join(configDir, 'projects', 'F--project-smoke', 'session-smoke.jsonl'),
      ),
    ).toBe(true)
  })

  it('deletes both metadata and workspace message data', async () => {
    const store = await loadStore()
    const meta = store.createSession({
      id: 'session-delete',
      workspaceId: 'workspace-delete',
    })
    store.appendMessages(meta.workspaceId, meta.id, [userMessage('删除我')])

    store.deleteSession(meta.id)

    expect(store.getSessionMeta(meta.id)).toBeUndefined()
    expect(store.readMessages(meta.workspaceId, meta.id)).toEqual([])
  })

  it('ignores malformed JSONL records without losing valid messages', async () => {
    const store = await loadStore()
    const meta = store.createSession({
      id: 'session-malformed',
      workspaceId: 'workspace-malformed',
    })
    store.appendMessages(meta.workspaceId, meta.id, [userMessage('有效消息')])
    const messagePath = join(
      configDir,
      'projects',
      'workspace-malformed',
      'session-malformed.jsonl',
    )
    const original = readFileSync(messagePath, 'utf8')
    const { appendFileSync } = await import('node:fs')
    appendFileSync(messagePath, '{ malformed json }\n', 'utf8')

    expect(original).toContain('有效消息')
    expect(store.readMessages(meta.workspaceId, meta.id)).toHaveLength(1)
  })
})
