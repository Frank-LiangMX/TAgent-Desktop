import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { workbenchDate } from '@tagent/shared'

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tagent-delegation-ipc-'))
process.env.TAGENT_CONFIG_DIR = CONFIG_DIR
process.env.TAGENT_DEV = '1'
vi.mock('electron', () => {
  const base = {
    ipcMain: { handle() {}, on() {}, once() {}, removeHandler() {}, removeAllListeners() {} },
    app: { isPackaged: false, getPath: () => CONFIG_DIR, getAppPath: () => CONFIG_DIR, on() {}, whenReady: async () => {} },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (s: Buffer) => s.toString() },
    BrowserWindow: class { static getAllWindows() { return [] } },
  }
  return new Proxy(base, { get: (obj, key) => Reflect.get(obj, key) ?? {} })
})
const h = vi.hoisted(() => ({
  build: vi.fn(async (_input: unknown) => [{ name: 'task', description: 'host-owned', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) }]),
  inject: vi.fn(async (servers: Record<string, unknown>, _input: unknown) => { servers['tagent-delegation'] = { type: 'sdk' } }),
  ask: vi.fn(),
}))
vi.mock('../agent/delegation-host-tools', () => ({ buildDelegationHostTools: h.build, injectDelegationMcpServer: h.inject }))
vi.mock('../agent/agent-ask-user-service', () => ({ askUserService: { handleAskUserQuestion: h.ask, clearSessionPending() {}, getPendingRequests: () => [] } }))
vi.mock('../channel/channel-store', async (original) => ({ ...await original<object>(), getDecryptedApiKey: () => 'test-key-not-real' }))
vi.mock('../workspace/workspace-manager', () => ({ resolveWorkspaceForSession: () => undefined, resolveWorkspaceById: () => undefined, listWorkspaces: () => [], getDefaultWorkspace: () => undefined }))

const { SessionService } = await import('./session-service')
const { createSession } = await import('../agent/session-store')
const { writeJsonAtomic } = await import('../atomic-json')
const { getChannelsPath } = await import('../config/config-paths')
const { workbenchService } = await import('../workbench/workbench-service')
const { PermissionService } = await import('../permission/permission-service')
const { wpsService } = await import('../wps/wps-service')
const channel = {
  id: 'api', name: 'API', provider: 'openai' as const, apiProtocol: 'openai-responses' as const,
  baseUrl: 'http://127.0.0.1:1', enabled: true, apiKey: '',
  models: [{ id: 'model', name: 'model', enabled: true }], defaultModelId: 'model', createdAt: 0, updatedAt: 0,
}
let service: ReturnType<typeof SessionService.create>
let seq = 0
beforeEach(() => {
  vi.clearAllMocks()
  writeJsonAtomic(getChannelsPath(), { version: 1, channels: [channel] })
  mkdirSync(join(CONFIG_DIR, 'memory'), { recursive: true })
  const getWindow = () => ({ webContents: { send() {} } }) as never
  service = SessionService.create(getWindow, PermissionService.create(getWindow))
})
afterEach(() => service.disposeAll())
afterAll(() => rmSync(CONFIG_DIR, { recursive: true, force: true }))

async function build(runtime: 'pi' | 'codex' | 'claude-code', mode: 'work' | 'chat' = 'work', forceKanbanDispatch = false): Promise<Record<string, any>> {
  const id = `delegate-${++seq}`
  createSession({ id, title: 'test', channelId: channel.id, modelId: 'model', agentRuntime: runtime, executionMode: mode, permissionMode: 'bypassPermissions' } as never)
  const selected = runtime === 'claude-code' ? { ...channel, provider: 'anthropic', apiProtocol: 'anthropic-messages' } : channel
  return (service as any).buildQueryOptions({ sessionId: id, prompt: forceKanbanDispatch ? '请开看板并行处理' : 'review', model: 'model', forceKanbanDispatch }, selected, runtime)
}

describe('main-session delegation wiring', () => {
  it.each(['pi', 'codex', 'claude-code'] as const)('%s mounts WPS user-message tools and reads both pages in Chat', async runtime => {
    const read = vi.spyOn(wpsService, 'queryMessages').mockImplementation(async query => query.pageToken
      ? { items: [{ id: 'second', content: { text: { content: '第二页原文' } } }], complete: true }
      : { items: [{ id: 'first', content: { text: { content: '第一页原文' } } }], nextPageToken: 'next', complete: false })
    let client: Client | undefined
    try {
      const opts = await build(runtime, 'chat')
      const prompt = opts.developerInstructions ?? opts.systemPromptAppend ?? opts.systemPrompt?.append
      expect(prompt).toContain('用户授权消息 MCP')
      let names: string[]
      let invoke: (name: string, args: Record<string, unknown>) => Promise<any>
      if (runtime === 'claude-code') {
        const [a, b] = InMemoryTransport.createLinkedPair()
        client = new Client({ name: 'wps-qa', version: '1.0' })
        await Promise.all([opts.mcpServers.wps.instance.connect(a), client.connect(b)])
        names = (await client.listTools()).tools.map(tool => tool.name)
        invoke = async (name, args) => {
          const result = await client!.callTool({ name, arguments: args })
          expect(result.isError).not.toBe(true)
          return JSON.parse((result.content as {text: string}[])[0]!.text)
        }
      } else if (runtime === 'codex') {
        names = opts.dynamicTools.map((tool: {name: string}) => tool.name)
        invoke = async (name, args) => {
          const result = await opts.onServerRequest({ method: 'item/tool/call', params: {
            threadId: 'qa', turnId: 'qa', callId: `qa-${++seq}`, namespace: null, tool: name, arguments: args,
          } })
          expect(result.success).toBe(true)
          return JSON.parse(result.contentItems[0].text)
        }
      } else {
        names = opts.extraTools.map((tool: {name: string}) => tool.name)
        invoke = async (name, args) => {
          expect(await opts.beforeToolCall({ toolCall: { name, arguments: args } })).toBeUndefined()
          return JSON.parse((await opts.extraTools.find((tool: {name: string}) => tool.name === name).execute('qa', args)).content[0].text)
        }
      }
      expect(names).toEqual(expect.arrayContaining(['wps_list_chats', 'wps_search_messages', 'wps_get_chat_messages', 'wps_collect_daily', 'wps_read_daily_evidence']))
      expect(names).not.toContain('wps_create_document')
      const args = { chatId: 'chat', startDate: '2026-09-01', endDate: '2026-09-02' }
      const first = await invoke('wps_get_chat_messages', args)
      expect(first).toMatchObject({ complete: false, nextPageToken: 'next', items: [{ id: 'first' }] })
      expect(await invoke('wps_get_chat_messages', { ...args, pageToken: first.nextPageToken })).toMatchObject({ complete: true, items: [{ id: 'second' }] })
      expect(read.mock.calls[1]![0]).toEqual({ ...args, pageToken: 'next', kind: 'history' })
    } finally {
      await client?.close()
      read.mockRestore()
    }
  })
  it.each(['pi', 'codex', 'claude-code'] as const)('%s creates a report through the host WPS tool only in Work', async runtime => {
    const create = vi.spyOn(wpsService, 'createDocument').mockResolvedValue({ created: true, title: '周报', fileId: 'file', url: 'https://365.kdocs.cn/l/report', location: 'MCP/智能文档' })
    let client: Client | undefined
    const args = { title: '周报', markdown: '# 本周进展\n\n- 完成联调' }
    try {
      const opts = await build(runtime, 'work')
      const prompt = opts.developerInstructions ?? opts.systemPromptAppend ?? opts.systemPrompt?.append
      expect(prompt).toContain('wps_create_document')
      let result: any
      if (runtime === 'claude-code') {
        const [a, b] = InMemoryTransport.createLinkedPair()
        client = new Client({ name: 'wps-write-qa', version: '1.0' })
        await Promise.all([opts.mcpServers.wps.instance.connect(a), client.connect(b)])
        expect((await client.listTools()).tools.find(tool => tool.name === 'wps_create_document')?.annotations?.readOnlyHint).toBe(false)
        const value = await client.callTool({ name: 'wps_create_document', arguments: args })
        expect(value.isError).not.toBe(true)
        result = JSON.parse((value.content as {text: string}[])[0]!.text)
      } else if (runtime === 'codex') {
        const value = await opts.onServerRequest({ method: 'item/tool/call', params: {
          threadId: 'qa', turnId: 'qa', callId: `qa-${++seq}`, namespace: null, tool: 'wps_create_document', arguments: args,
        } })
        expect(value.success).toBe(true)
        result = JSON.parse(value.contentItems[0].text)
      } else {
        expect(await opts.beforeToolCall({ toolCall: { name: 'wps_create_document', arguments: args } })).toBeUndefined()
        const value = await opts.extraTools.find((tool: {name: string}) => tool.name === 'wps_create_document').execute('qa', args)
        result = JSON.parse(value.content[0].text)
      }
      expect(result).toMatchObject({ created: true, url: 'https://365.kdocs.cn/l/report' })
      expect(create).toHaveBeenCalledTimes(1)
      expect(create.mock.calls[0]![0]).toEqual(args)
    } finally { await client?.close(); create.mockRestore() }
  })
  it.each(['pi'] as const)('%s 暂停班组工具和派工引导，但保留子代理', async (runtime) => {
    const opts = await build(runtime, 'work', true);
    expect((opts.dynamicTools ?? opts.extraTools ?? []).some((t: { name: string }) => t.name.startsWith('kanban_'))).toBe(false);
    expect(Object.keys(opts.mcpServers ?? {}).some((name) => /kanban/.test(name))).toBe(false);
    const prompt = opts.developerInstructions ?? opts.systemPromptAppend ?? opts.systemPrompt?.append ?? '';
    expect(prompt).not.toContain('## 看板派工工具');
    expect(prompt).not.toContain('kanban_create_board');
    expect(prompt).not.toContain('本轮看板派工');
    expect(prompt).toContain('子代理');
  });
  it('mounts personal workbench reads in Chat and writes only in Work', async () => {
    const chat = await build('pi', 'chat')
    expect(chat.extraTools.map((tool: {name:string}) => tool.name)).toEqual(expect.arrayContaining(['workbench_search','workbench_get']))
    expect(chat.extraTools.some((tool: {name:string}) => tool.name === 'workbench_add')).toBe(false)
    const work = await build('pi', 'work')
    expect(work.extraTools.some((tool: {name:string}) => tool.name === 'workbench_add')).toBe(true)
    expect(work.systemPromptAppend).toContain('## 个人工作台')
  })
  it.each(['pi', 'codex', 'claude-code'] as const)('%s exposes actual stored plans in Chat and saves tagged content only in Work', async runtime => {
    const day = workbenchDate()
    const title = `QA-${runtime}-${++seq}`
    const state = workbenchService.mutate({ expectedRevision: workbenchService.read().revision, change: {
      type: 'save-todo', title, project: 'QA', dueDate: day, dueTime: '14:00', area: 'work', tags: ['QA/工作台'],
    } })
    const todo = state.todos.at(-1)!
    for (const mode of ['chat', 'work'] as const) {
      const opts = await build(runtime, mode)
      const prompt = opts.developerInstructions ?? opts.systemPromptAppend ?? opts.systemPrompt?.append
      expect(prompt).toContain('## 个人工作台')
      let client: Client | undefined
      let names: string[]
      let invoke: (name: string, args: Record<string, unknown>) => Promise<any>
      if (runtime === 'claude-code') {
        const server = opts.mcpServers.workbench.instance
        const [a, b] = InMemoryTransport.createLinkedPair()
        client = new Client({ name: 'workbench-qa', version: '1.0' })
        await Promise.all([server.connect(a), client.connect(b)])
        names = (await client.listTools()).tools.map(tool => tool.name)
        invoke = async (name, args) => {
          const value = await client!.callTool({ name, arguments: args })
          expect(value.isError).not.toBe(true)
          return JSON.parse((value.content as { text: string }[])[0]!.text)
        }
      } else if (runtime === 'codex') {
        names = opts.dynamicTools.map((tool: { name: string }) => tool.name)
        invoke = async (name, args) => {
          const value = await opts.onServerRequest({ method: 'item/tool/call', params: {
            threadId: 'qa', turnId: 'qa', callId: `qa-${++seq}`, namespace: null, tool: name, arguments: args,
          } })
          expect(value.success).toBe(true)
          return JSON.parse(value.contentItems[0].text)
        }
      } else {
        names = opts.extraTools.map((tool: { name: string }) => tool.name)
        invoke = async (name, args) => {
          expect(await opts.beforeToolCall({ toolCall: { name, arguments: args } })).toBeUndefined()
          const value = await opts.extraTools.find((tool: { name: string }) => tool.name === name).execute(`qa-${++seq}`, args)
          return JSON.parse(value.content[0].text)
        }
      }
      try {
        expect(names).toEqual(expect.arrayContaining(['workbench_search', 'workbench_get', 'workbench_history']))
        expect(names.includes('workbench_add')).toBe(mode === 'work')
        expect(names.includes('workbench_update_note')).toBe(mode === 'work')
        const found = await invoke('workbench_search', { query: title, from: day, to: day, type: 'todo' })
        expect(found.items).toEqual([expect.objectContaining({ id: todo.id, dueTime: '14:00' })])
        expect(await invoke('workbench_get', { id: todo.id })).toMatchObject({ ok: true, text: title })
        expect(await invoke('workbench_history', { from: day, query: title })).toMatchObject({ ok: true })
        if (mode === 'work') {
          const saved = await invoke('workbench_add', { type: 'note', content: `${title} 实际保存`, tags: ['QA/验证'], date: day })
          expect(saved.ok).toBe(true)
          expect(workbenchService.read().notes.find(note => note.id === saved.id)?.content).toBe(`${title} 实际保存`)
          const updated = await invoke('workbench_update_note', { id: saved.id, expectedRevision: saved.revision, content: `${title} 补充信息` })
          expect(updated.ok).toBe(true)
          expect(workbenchService.read().notes.find(note => note.id === saved.id)?.content).toBe(`${title} 补充信息`)
        }
      } finally {
        await client?.close()
      }
    }
  })
  it('Pi receives delegation policy and approval requires the exact affirmative answer', async () => {
    const opts = await build('pi')
    expect(opts.systemPromptAppend).toContain('子代理')
    h.ask.mockResolvedValue({ behavior: 'allow', updatedInput: { answers: { delegate: '取消派发' } } })
    expect(await opts.requestDelegationApproval('worker')).toBe(false)
    h.ask.mockResolvedValue({ behavior: 'allow', updatedInput: { answers: { delegate: '允许派发' } } })
    expect(await opts.requestDelegationApproval('worker')).toBe(true)
    const stop = new AbortController()
    stop.abort()
    expect(await opts.requestDelegationApproval('worker', stop.signal)).toBe(false)
    expect(h.ask).toHaveBeenCalledTimes(2)
  })
})

describe('automated turn completion', () => {
  it.each(['success', 'error'])('waits for the native %s terminal before completing a task', async outcome => {
    const id = `auto-terminal-${++seq}`
    createSession({ id, title: '自动任务', channelId: channel.id, modelId: 'model' } as never)
    const internals = service as any
    const send = vi.spyOn(internals, 'handleSend').mockResolvedValue(undefined)
    const status = vi.spyOn(internals, 'getStatus').mockReturnValue({ status: 'running', archived: false })
    // Preflight is idle, then sending starts the runtime.
    status.mockReturnValueOnce({ status: 'idle', archived: false })
    let settled = false
    const result = service.runAutomatedTurn({ sessionId: id, prompt: '运行任务', channelId: channel.id, waitForCompletion: true })
      .then(() => { settled = true; return 'ok' }, err => { settled = true; return err.message })
    await Promise.resolve()
    expect(send).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    await expect(service.runAutomatedTurn({ sessionId: id, prompt: '重复运行', channelId: channel.id, waitForCompletion: true })).rejects.toThrow('正在执行')
    const terminal = internals.automatedTurns.get(id)
    terminal.outcome = outcome
    if (outcome === 'error') terminal.error = '模型执行失败'
    internals.resolveNextTurnEndWaiters(id)
    expect(await result).toBe(outcome === 'success' ? 'ok' : '模型执行失败')
    expect(internals.automatedTurns.has(id)).toBe(false)
    send.mockRestore(); status.mockRestore()
  })
  it('cleans up waiters after a startup failure so the task can be retried', async () => {
    const id = `auto-startup-${++seq}`
    createSession({ id, title: '自动任务', channelId: channel.id, modelId: 'model' } as never)
    const internals = service as any
    const send = vi.spyOn(internals, 'handleSend').mockRejectedValue(new Error('渠道不可用'))
    await expect(service.runAutomatedTurn({ sessionId: id, prompt: '运行', channelId: channel.id, waitForCompletion: true })).rejects.toThrow('渠道不可用')
    expect(internals.automatedTurns.has(id)).toBe(false)
    expect(internals.nextTurnEndWaiters.has(id)).toBe(false)
    send.mockRestore()
  })
})
