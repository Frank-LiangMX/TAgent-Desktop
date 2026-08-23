import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SDKMessage, MoADiscussionPanel } from '@tagent/shared'
import {
  createMoADiscussionPanel,
  appendDiscussionEntry,
  finalizeMoADiscussion,
} from '@tagent/shared'

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

  it('persists session Bot references across module reloads', async () => {
    const store = await loadStore()
    const created = store.createSession({
      id: 'session-bot-members',
      workspaceId: 'workspace-bot-members',
    })

    store.updateSessionMeta(created.id, {
      botProfileIds: ['bot-researcher', 'bot-writer'],
    })

    const reloaded = await loadStore()
    expect(reloaded.getSessionMeta(created.id)?.botProfileIds).toEqual([
      'bot-researcher',
      'bot-writer',
    ])
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

  it('persists cliWorkerId (SLICE-7 会话级 CLI 工人偏好)', async () => {
    const store = await loadStore()
    const created = store.createSession({
      id: 'session-cli-worker',
      workspaceId: 'workspace-cli-worker',
    })
    // 写入会话偏好工人 → 重读一致
    store.updateSessionMeta(created.id, { cliWorkerId: 'grok' })
    let reloaded = await loadStore()
    expect(reloaded.getSessionMeta(created.id)).toMatchObject({
      id: 'session-cli-worker',
      cliWorkerId: 'grok',
    })
    // 清回 undefined（选「自动」）→ 重读为 undefined，不残留
    store.updateSessionMeta(created.id, { cliWorkerId: undefined })
    reloaded = await loadStore()
    expect(reloaded.getSessionMeta(created.id)?.cliWorkerId).toBeUndefined()
  })
})

describe('session-store moa-discussion persistence (T8)', () => {
  /** 2 参考席的合法 panel seed（与会诊预置 references≥2 校验对齐） */
  function seedPanel(discussionId: string, topic: string): MoADiscussionPanel {
    return createMoADiscussionPanel({
      discussionId,
      presetName: '深度圆桌',
      topic,
      participants: [
        { speakerId: 'ref-0', name: '架构师', modelId: 'glm-5.2' },
        { speakerId: 'ref-1', name: '实战派', modelId: 'kimi-k2.5' },
      ],
      roundLimit: 2,
    })
  }

  it('appendMoADiscussionPanelRecord → readMoADiscussionPanels 往返重建 panel（含 entries+summary）', async () => {
    const store = await loadStore()
    const meta = store.createSession({
      id: 'session-moa-disc',
      workspaceId: 'workspace-moa-disc',
    })
    const panel = finalizeMoADiscussion(
      appendDiscussionEntry(
        appendDiscussionEntry(seedPanel('moa-disc-session-moa-disc-0', '如何拆分模块？'), {
          speakerId: 'ref-0',
          text: '架构师建议按 DDD 拆',
        }),
        { speakerId: 'ref-1', text: '实战派建议先做 PoC' },
      ),
      '共识方案：分两步实施，先 PoC 再 DDD 限界上下文。',
    )

    store.appendMoADiscussionPanelRecord(meta.workspaceId, meta.id, panel)

    // 文件落在面板 JSONL 同目录
    expect(
      existsSync(
        join(configDir, 'projects', 'workspace-moa-disc', 'session-moa-disc.moa-discussion.jsonl'),
      ),
    ).toBe(true)

    // 模块重载（重启语义）后读回 → 重建出等价 panel
    const reloaded = await loadStore()
    const panels = reloaded.readMoADiscussionPanels(meta.workspaceId, meta.id)
    expect(panels).toHaveLength(1)
    const restored = panels[0]!
    expect(restored.discussionId).toBe(panel.discussionId)
    expect(restored.phase).toBe('done')
    expect(restored.presetName).toBe('深度圆桌')
    expect(restored.topic).toBe('如何拆分模块？')
    expect(restored.summary).toBe('共识方案：分两步实施，先 PoC 再 DDD 限界上下文。')
    expect(restored.entries).toHaveLength(2)
    expect(restored.entries.map((e) => e.speakerId)).toEqual(['ref-0', 'ref-1'])
    expect(restored.entries.map((e) => e.text)).toEqual([
      '架构师建议按 DDD 拆',
      '实战派建议先做 PoC',
    ])
    // speakers 完整（participants + user + moderator 由 createMoADiscussionPanel 自动追加）
    expect(restored.speakers.map((s) => s.role)).toEqual([
      'participant',
      'participant',
      'user',
      'moderator',
    ])
  })

  it('一行一场：多场按落盘顺序读回', async () => {
    const store = await loadStore()
    const meta = store.createSession({ id: 'session-multi', workspaceId: 'ws-multi' })
    store.appendMoADiscussionPanelRecord(meta.workspaceId, meta.id, seedPanel('d1', '议题一'))
    store.appendMoADiscussionPanelRecord(meta.workspaceId, meta.id, seedPanel('d2', '议题二'))

    const reloaded = await loadStore()
    const panels = reloaded.readMoADiscussionPanels(meta.workspaceId, meta.id)
    expect(panels).toHaveLength(2)
    expect(panels.map((p) => p.discussionId)).toEqual(['d1', 'd2'])
    expect(panels.map((p) => p.topic)).toEqual(['议题一', '议题二'])
  })

  it('readMoADiscussionPanels 跳过坏行，不丢有效记录', async () => {
    const store = await loadStore()
    const meta = store.createSession({ id: 'session-bad', workspaceId: 'ws-bad' })
    store.appendMoADiscussionPanelRecord(meta.workspaceId, meta.id, seedPanel('good', '议题'))
    const path = join(configDir, 'projects', 'ws-bad', 'session-bad.moa-discussion.jsonl')
    const { appendFileSync } = await import('node:fs')
    appendFileSync(path, '{ malformed json }\n', 'utf8')

    const reloaded = await loadStore()
    const panels = reloaded.readMoADiscussionPanels(meta.workspaceId, meta.id)
    expect(panels).toHaveLength(1)
    expect(panels[0]!.discussionId).toBe('good')
  })

  it('deleteSession 一并清理 moa-discussion.jsonl', async () => {
    const store = await loadStore()
    const meta = store.createSession({ id: 'session-del-disc', workspaceId: 'ws-del-disc' })
    store.appendMoADiscussionPanelRecord(meta.workspaceId, meta.id, seedPanel('d', '议题'))
    const path = join(
      configDir,
      'projects',
      'ws-del-disc',
      'session-del-disc.moa-discussion.jsonl',
    )
    expect(existsSync(path)).toBe(true)

    store.deleteSession(meta.id)

    expect(existsSync(path)).toBe(false)
    expect(store.readMoADiscussionPanels(meta.workspaceId, meta.id)).toEqual([])
  })

  it('recallLastUnsentUserTurn removes last user when agent has not replied', async () => {
    const store = await loadStore()
    const meta = store.createSession({ id: 'session-recall', workspaceId: 'ws-recall' })
    const history = [
      userMessage('旧问题'),
      { type: 'assistant', createdAt: Date.now(), content: [{ type: 'text', text: '旧回答' }] },
      userMessage('撤回我'),
    ]
    store.appendPanelMessages(meta.workspaceId, meta.id, history)
    store.appendSdkMessages(meta.workspaceId, meta.id, history)

    const res = store.recallLastUnsentUserTurn(meta.workspaceId, meta.id)
    expect(res).toEqual({ ok: true, text: '撤回我' })
    expect(store.readPanelMessages(meta.workspaceId, meta.id)).toHaveLength(2)
    expect(store.readSdkMessages(meta.workspaceId, meta.id)).toHaveLength(2)
  })

  it('recallLastUnsentUserTurn refuses when assistant already followed user', async () => {
    const store = await loadStore()
    const meta = store.createSession({ id: 'session-recall-no', workspaceId: 'ws-recall-no' })
    store.appendPanelMessages(meta.workspaceId, meta.id, [
      userMessage('新问题'),
      { type: 'assistant', createdAt: Date.now(), content: [{ type: 'text', text: '已开始' }] },
    ])

    expect(store.recallLastUnsentUserTurn(meta.workspaceId, meta.id)).toEqual({
      ok: false,
      reason: 'already_started',
    })
  })
})
