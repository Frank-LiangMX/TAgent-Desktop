import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tagent-delegation-ipc-'))
process.env.TAGENT_CONFIG_DIR = CONFIG_DIR
process.env.TAGENT_DEV = '1'
vi.mock('electron', () => {
  const base = {
    ipcMain: { handle() {}, on() {}, once() {}, removeHandler() {}, removeAllListeners() {} },
    app: { isPackaged: false, getPath: () => CONFIG_DIR, getAppPath: () => CONFIG_DIR, on() {}, whenReady: async () => {} },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (s: Buffer) => s.toString() },
    BrowserWindow: class {},
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
  service = SessionService.create(() => ({ webContents: { send() {} } }) as never, null)
})
afterEach(() => service.disposeAll())
afterAll(() => rmSync(CONFIG_DIR, { recursive: true, force: true }))

async function build(runtime: 'pi' | 'codex' | 'claude-code', mode: 'work' | 'chat' = 'work', forceKanbanDispatch = false): Promise<Record<string, any>> {
  const id = `delegate-${++seq}`
  createSession({ id, title: 'test', channelId: channel.id, modelId: 'model', agentRuntime: runtime, executionMode: mode } as never)
  const selected = runtime === 'claude-code' ? { ...channel, provider: 'anthropic', apiProtocol: 'anthropic-messages' } : channel
  return (service as any).buildQueryOptions({ sessionId: id, prompt: forceKanbanDispatch ? '请开看板并行处理' : 'review', model: 'model', forceKanbanDispatch }, selected, runtime)
}

describe('main-session delegation wiring', () => {
  it.each(['pi', 'codex', 'claude-code'] as const)('%s 暂停班组工具和派工引导，但保留子代理', async (runtime) => {
    const opts = await build(runtime, 'work', true);
    expect((opts.dynamicTools ?? opts.extraTools ?? []).some((t: { name: string }) => t.name.startsWith('kanban_'))).toBe(false);
    expect(Object.keys(opts.mcpServers ?? {}).some((name) => /kanban/.test(name))).toBe(false);
    const prompt = opts.developerInstructions ?? opts.systemPromptAppend ?? opts.systemPrompt?.append ?? '';
    expect(prompt).not.toContain('## 看板派工工具');
    expect(prompt).not.toContain('kanban_create_board');
    expect(prompt).not.toContain('本轮看板派工');
    expect(prompt).toContain('子代理');
  });
  it('Codex Work exposes the host task and disables the unbudgeted native delegation path', async () => {
    const opts = await build('codex')
    expect(opts.dynamicTools.some((t: { name: string }) => t.name === 'task')).toBe(true)
    expect(opts.config['features.multi_agent']).toBe(false)
    expect(h.build).toHaveBeenCalledTimes(1)
    const input = h.build.mock.calls[0]![0] as any
    expect(input.channelConfig.modelId).toBe('model')
    expect(await input.beforeToolCall({ toolCall: { name: 'Write', arguments: {} } })).toMatchObject({ block: true })
  })
  it('Claude Work uses host MCP delegation, not native Agent/Task', async () => {
    const opts = await build('claude-code')
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(opts.mcpServers['tagent-delegation']).toBeDefined()
    expect(opts.disallowedTools).toEqual(['Agent', 'Task'])
    expect(opts.agents).toBeUndefined()
  })
  it('does not expose host task in native Chat sessions', async () => {
    await build('codex', 'chat')
    await build('claude-code', 'chat')
    expect(h.build).not.toHaveBeenCalled()
    expect(h.inject).not.toHaveBeenCalled()
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
