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
  it('persists workspace-bound metadata and dual JSONL across module reloads', async () => {
    const store = await loadStore()
    const created = store.createSession({
      id: 'session-smoke',
      title: '持久化冒烟',
      channelId: 'channel-1',
      modelId: 'model-1',
      workspaceId: 'F--project-smoke',
      turnCount: 1,
    })
    const msgs = [userMessage('第一条'), userMessage('第二条')]
    store.appendPanelMessages(created.workspaceId, created.id, msgs)
    store.appendSdkMessages(created.workspaceId, created.id, msgs)
    store.updateSessionMeta(created.id, { pinned: true, turnCount: 2 })

    const reloaded = await loadStore()
    const meta = reloaded.getSessionMeta(created.id)
    const panel = reloaded.readPanelMessages(created.workspaceId, created.id)
    const sdk = reloaded.readSdkMessages(created.workspaceId, created.id)

    expect(meta).toMatchObject({
      id: 'session-smoke',
      title: '持久化冒烟',
      channelId: 'channel-1',
      modelId: 'model-1',
      workspaceId: 'F--project-smoke',
      turnCount: 2,
      pinned: true,
    })
    expect(panel).toHaveLength(2)
    expect(sdk).toHaveLength(2)
    expect(panel[0]).toMatchObject({
      type: 'user',
      message: { role: 'user' },
    })
    expect(
      existsSync(
        join(configDir, 'projects', 'F--project-smoke', 'session-smoke.jsonl'),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(configDir, 'projects', 'F--project-smoke', 'session-smoke.messages.jsonl'),
      ),
    ).toBe(true)
  })

  it('panel history survives SDK JSONL rewrite (D5)', async () => {
    const store = await loadStore()
    const meta = store.createSession({
      id: 'session-compact',
      workspaceId: 'workspace-compact',
    })
    const msgs = [userMessage('历史1'), userMessage('历史2'), userMessage('历史3')]
    store.appendPanelMessages(meta.workspaceId, meta.id, msgs)
    store.appendSdkMessages(meta.workspaceId, meta.id, msgs)

    // 模拟压缩：重写 SDK 份为摘要
    store.writeSdkMessages(meta.workspaceId, meta.id, [userMessage('压缩摘要')])

    expect(store.readSdkMessages(meta.workspaceId, meta.id)).toHaveLength(1)
    expect(store.readPanelMessages(meta.workspaceId, meta.id)).toHaveLength(3)
  })

  it('readPanelMessages falls back to SDK JSONL for legacy single-file sessions', async () => {
    const store = await loadStore()
    const meta = store.createSession({
      id: 'session-legacy',
      workspaceId: 'workspace-legacy',
    })
    // 仅写 SDK 份（迁移前老会话）
    store.appendSdkMessages(meta.workspaceId, meta.id, [userMessage('老数据')])

    expect(store.readPanelMessages(meta.workspaceId, meta.id)).toHaveLength(1)
    expect(
      existsSync(
        join(configDir, 'projects', 'workspace-legacy', 'session-legacy.messages.jsonl'),
      ),
    ).toBe(false)
  })

  it('deletes both metadata and dual message files', async () => {
    const store = await loadStore()
    const meta = store.createSession({
      id: 'session-delete',
      workspaceId: 'workspace-delete',
    })
    store.appendPanelMessages(meta.workspaceId, meta.id, [userMessage('删除我')])
    store.appendSdkMessages(meta.workspaceId, meta.id, [userMessage('删除我')])

    store.deleteSession(meta.id)

    expect(store.getSessionMeta(meta.id)).toBeUndefined()
    expect(store.readPanelMessages(meta.workspaceId, meta.id)).toEqual([])
    expect(store.readSdkMessages(meta.workspaceId, meta.id)).toEqual([])
    expect(
      existsSync(join(configDir, 'projects', 'workspace-delete', 'session-delete.jsonl')),
    ).toBe(false)
    expect(
      existsSync(
        join(configDir, 'projects', 'workspace-delete', 'session-delete.messages.jsonl'),
      ),
    ).toBe(false)
  })

  it('deletes every session in one workspace without affecting other workspaces', async () => {
    const store = await loadStore()
    const first = store.createSession({ id: 'workspace-a-1', workspaceId: 'workspace-a' })
    const second = store.createSession({ id: 'workspace-a-2', workspaceId: 'workspace-a' })
    const untouched = store.createSession({ id: 'workspace-b-1', workspaceId: 'workspace-b' })
    store.appendPanelMessages(first.workspaceId, first.id, [userMessage('删除一')])
    store.appendSdkMessages(first.workspaceId, first.id, [userMessage('删除一')])
    store.appendPanelMessages(second.workspaceId, second.id, [userMessage('删除二')])
    store.appendSdkMessages(second.workspaceId, second.id, [userMessage('删除二')])
    store.appendPanelMessages(untouched.workspaceId, untouched.id, [userMessage('保留')])
    store.appendSdkMessages(untouched.workspaceId, untouched.id, [userMessage('保留')])

    const deletedIds = store.deleteSessionsByWorkspace('workspace-a')

    expect(deletedIds).toEqual(['workspace-a-1', 'workspace-a-2'])
    expect(store.getSessionMeta(first.id)).toBeUndefined()
    expect(store.getSessionMeta(second.id)).toBeUndefined()
    expect(store.readPanelMessages(first.workspaceId, first.id)).toEqual([])
    expect(store.readPanelMessages(second.workspaceId, second.id)).toEqual([])
    expect(store.getSessionMeta(untouched.id)).toBeDefined()
    expect(store.readPanelMessages(untouched.workspaceId, untouched.id)).toHaveLength(1)
  })

  it('ignores malformed JSONL records without losing valid messages', async () => {
    const store = await loadStore()
    const meta = store.createSession({
      id: 'session-malformed',
      workspaceId: 'workspace-malformed',
    })
    store.appendPanelMessages(meta.workspaceId, meta.id, [userMessage('有效消息')])
    store.appendSdkMessages(meta.workspaceId, meta.id, [userMessage('有效消息')])
    const messagePath = join(
      configDir,
      'projects',
      'workspace-malformed',
      'session-malformed.messages.jsonl',
    )
    const original = readFileSync(messagePath, 'utf8')
    const { appendFileSync } = await import('node:fs')
    appendFileSync(messagePath, '{ malformed json }\n', 'utf8')

    expect(original).toContain('有效消息')
    expect(store.readPanelMessages(meta.workspaceId, meta.id)).toHaveLength(1)
  })

  it('persists soft-reset meta fields (Phase 1.3)', async () => {
    const store = await loadStore()
    const created = store.createSession({
      id: 'session-shadow',
      workspaceId: 'workspace-shadow',
    })
    store.updateSessionMeta(created.id, {
      shadowSessionId: 'sdk-shadow-b',
      shadowState: 'ready',
      shadowCursor: 'msg-uuid-1',
      shadowChainPrev: 'sdk-a',
      learnedSafeContextLimit: 180_000,
      lastBurstTokenCount: 256_000,
    })
    const reloaded = await loadStore()
    expect(reloaded.getSessionMeta(created.id)).toMatchObject({
      shadowSessionId: 'sdk-shadow-b',
      shadowState: 'ready',
      shadowCursor: 'msg-uuid-1',
      shadowChainPrev: 'sdk-a',
      learnedSafeContextLimit: 180_000,
      lastBurstTokenCount: 256_000,
    })
  })
})
