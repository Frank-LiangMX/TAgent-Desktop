/** Real Pi loop + HTTP transport, loopback only; no company credentials or native processes. */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Channel } from '@tagent/shared'

const fixture = vi.hoisted(() => ({ channels: [] as Channel[] }))
const configDir = mkdtempSync(join(tmpdir(), 'tagent-task-wire-'))
process.env.TAGENT_CONFIG_DIR = configDir
vi.mock('../../channel/channel-store', () => ({ listChannels: () => fixture.channels, getDecryptedApiKey: () => 'loopback-only' }))
vi.mock('../../agent/agent-catalog-service', () => ({ listAgentProfiles: () => [] }))
vi.mock('../../agent/agent-crew-prefs', () => ({ readAgentCrewPrefs: () => ({ maxParallelWorkers: 3 }) }))
vi.mock('../../agent/official-delegated-agent', () => ({ runOfficialDelegatedAgent: () => { throw new Error('native runtime forbidden in loopback test') } }))
vi.mock('../../agent/subagent-definitions', () => ({ buildBuiltinSubagentDefinitions: () => ({ explorer: { prompt: 'Reply briefly.', tools: [] } }), resolveSubagentDefinition: () => undefined }))
vi.mock('../../agent/session-process-registry', () => ({ bashHooksForSession: () => undefined }))

import { createTaskTool } from './subagent-task-tool'
import { countDelegationSlots } from '../../agent/delegation-capacity'
import { countRunningBackgroundTasks } from '../../agent/background-delegation-service'
afterAll(() => rmSync(configDir, { recursive: true, force: true }))

describe('delegated Pi API wire', () => {
  it.each(['three-workers', 'ignores-summary', 'time-budget', 'user-stop'] as const)('Anthropic boundary: %s', async (scenario) => {
    const bodies: Array<{ tools?: unknown[]; system?: unknown; messages: unknown[] }> = []
    const server = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk.toString()
      const body = JSON.parse(raw)
      bodies.push(body)
      const isSummary = !body.tools?.length
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      send({ type: 'message_start', message: { id: 'budget-fixture', type: 'message', role: 'assistant', model: 'deepseek-fixture', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
      const calls = !isSummary || scenario === 'ignores-summary'
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: calls ? 'checking fixture' : '已检查入口；其余模块尚未检查。' } })
      send({ type: 'content_block_stop', index: 0 })
      if (calls) {
        const count = scenario === 'time-budget' || scenario === 'user-stop' ? 1 : 21
        for (let i = 1; i <= count; i++) {
          send({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `read-${i}`, name: 'fixture_tool', input: {} } })
          send({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: '{"path":"ignored"}' } })
          send({ type: 'content_block_stop', index: i })
        }
      }
      send({ type: 'message_delta', delta: { stop_reason: calls ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } })
      send({ type: 'message_stop' })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    fixture.channels = [{ id: 'messages-channel', name: 'fixture', provider: 'kscc-gateway', apiProtocol: 'anthropic-messages', baseUrl, apiKey: '', enabled: true,
      models: [{ id: 'deepseek-fixture', name: 'fixture', enabled: true }], defaultModelId: 'deepseek-fixture', createdAt: 0, updatedAt: 0 }]
    const [piCore, piAgentCore] = await Promise.all([import('@tagent/pi-core'), import('@earendil-works/pi-agent-core')])
    const controller = new AbortController()
    const now = Date.now.bind(Date)
    let offset = 0
    const clock = scenario === 'time-budget' ? vi.spyOn(Date, 'now').mockImplementation(() => now() + offset) : undefined
    const execute = vi.fn(async () => {
      if (scenario === 'user-stop') controller.abort()
      if (scenario === 'time-budget') offset = 91_000
      return { content: [{ type: 'text' as const, text: 'fixture observation' }], details: { path: 'ignored', lines: 1 } }
    })
    const notifications: Array<{ type: string; status?: string }> = []
    const task = createTaskTool('messages-parent', { type: 'external', provider: 'kscc-gateway', apiProtocol: 'anthropic-messages', apiKey: 'loopback-only', baseUrl, modelId: 'deepseek-fixture' }, configDir,
      { ...piCore, defaultTools: [{ ...piCore.readTool, name: 'fixture_tool', execute }] }, piAgentCore, async () => undefined, (event) => { notifications.push(event) }, undefined, undefined, undefined, 'messages-channel')
    try {
      const count = scenario === 'three-workers' ? 3 : 1
      const results = await Promise.all(Array.from({ length: count }, (_, i) => task.execute(`task-${scenario}-${i}`, {
        subagent_type: 'explorer', prompt: 'Inspect a bounded fixture module.', mode: 'foreground', complexity: 'simple',
      }, controller.signal)))
      const status = scenario === 'ignores-summary' ? 'failed' : scenario === 'user-stop' ? 'stopped' : 'partial'
      expect(results.map((r) => r.details.outcome)).toEqual(Array(count).fill(status))
      expect(notifications.filter((n) => n.type === 'task_notification').map((n) => n.status)).toEqual(Array(count).fill(status))
      expect(execute).toHaveBeenCalledTimes(scenario === 'time-budget' || scenario === 'user-stop' ? 1 : count * 20)
      const summaryRequests = bodies.filter((b) => !b.tools?.length)
      expect(summaryRequests).toHaveLength(scenario === 'user-stop' ? 0 : count)
      for (const request of summaryRequests) expect(JSON.stringify(request.system)).toContain('阶段报告')
      if (status === 'partial') for (const result of results) expect(JSON.stringify(result.content)).toContain('其余模块尚未检查')
      if (scenario === 'ignores-summary') expect(results[0]?.details.failureReason).toContain('预算收尾后仍请求工具')
      expect(countDelegationSlots('messages-parent')).toBe(0)
      expect(countRunningBackgroundTasks('messages-parent')).toBe(0)
    } finally {
      clock?.mockRestore()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('routes explicit cross-channel model and treats real HTTP failure as failed, releasing capacity', async () => {
    const received: Array<{ url: string; model: string }> = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        const body = JSON.parse(raw)
        received.push({ url: req.url!, model: body.model })
        if (body.model === 'bad-model') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'fixture rejection', type: 'invalid_request_error' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (body.model === 'budget-model' && !body.messages.some((message: { role: string }) => message.role === 'tool')) {
          res.write(`data: ${JSON.stringify({ id: 'fixture-budget', choices: [{ index: 0, delta: {
            role: 'assistant', content: 'partial observation',
            tool_calls: Array.from({ length: 21 }, (_, index) => ({ index, id: `budget-${index}`, type: 'function', function: { name: 'fixture_tool', arguments: JSON.stringify({ path: 'ignored' }) } })),
          }, finish_reason: null }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ id: 'fixture-budget', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
          res.end('data: [DONE]\n\n')
          return
        }
        if (body.model === 'child-model' && !body.messages.some((message: { role: string }) => message.role === 'tool')) {
          res.write(`data: ${JSON.stringify({ id: 'fixture-tool', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'intermediate commentary', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'fixture_tool', arguments: JSON.stringify({ path: 'ignored' }) } }] }, finish_reason: null }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ id: 'fixture-tool', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
          res.end('data: [DONE]\n\n')
          return
        }
        for (const choice of [
          { index: 0, delta: { role: 'assistant', content: 'verified child output' }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: 'stop' },
        ]) {
          res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [choice] })}\n\n`)
        }
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const baseUrl = `http://127.0.0.1:${address.port}/v1`
    fixture.channels = ['parent-channel', 'child-channel'].map(id => ({
      id, name: id, provider: 'openai', apiProtocol: 'openai-chat', baseUrl, apiKey: '', enabled: true,
      models: ['parent-model', 'child-model', 'bad-model', 'budget-model'].map(model => ({ id: model, name: model, enabled: true })),
      defaultModelId: 'parent-model', createdAt: 0, updatedAt: 0,
    }))
    const [piCore, piAgentCore] = await Promise.all([import('@tagent/pi-core'), import('@earendil-works/pi-agent-core')])
    const childExecute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'tool observation' }], details: { path: 'ignored', lines: 1 } }))
    const permissionHook = vi.fn(async () => undefined)
    const task = createTaskTool('wire-parent', { type: 'external', provider: 'openai', apiProtocol: 'openai-chat', apiKey: 'loopback-only', baseUrl, modelId: 'parent-model' }, configDir,
      { ...piCore, defaultTools: [{ ...piCore.readTool, name: 'fixture_tool', execute: childExecute }] }, piAgentCore, permissionHook, undefined, undefined, undefined, undefined, 'parent-channel')
    try {
      const success = await task.execute('wire-success', { subagent_type: 'explorer', prompt: 'inspect', mode: 'foreground', channel: 'child-channel', model: 'child-model', selectionReason: 'Independent simple check on configured channel', complexity: 'simple' })
      expect(success.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('verified child output') })]))
      expect((success as unknown as { status: string }).status).toBe('completed')
      expect(JSON.stringify(success.content)).not.toContain('intermediate commentary')
      expect(childExecute).toHaveBeenCalledTimes(1)
      expect(permissionHook).toHaveBeenCalledTimes(1)
      const failure = await task.execute('wire-failure', { subagent_type: 'explorer', prompt: 'inspect', mode: 'foreground', channel: 'child-channel', model: 'bad-model', selectionReason: 'Test explicit rejected request', complexity: 'simple' })
      expect((failure as unknown as { status: string }).status).toBe('failed')
      expect(received.map(r => r.model)).toEqual(['child-model', 'child-model', 'bad-model'])
      expect(received.every(r => r.url.includes('/chat/completions'))).toBe(true)
      childExecute.mockClear()
      const limited = await task.execute('wire-budget', { subagent_type: 'explorer', prompt: 'inspect many files', mode: 'foreground', channel: 'child-channel', model: 'budget-model', selectionReason: 'Test tool budget within a single batch', complexity: 'simple' })
      expect((limited as unknown as { status: string }).status).toBe('partial')
      expect(limited.details).toMatchObject({ toolCalls: 21, stopReason: 'stop', budgetReason: expect.stringContaining('20') })
      expect(limited.content[0]).toMatchObject({ text: expect.stringContaining('verified child output') })
      expect(childExecute).toHaveBeenCalledTimes(20)
      expect(countDelegationSlots('wire-parent')).toBe(0)
      expect(countRunningBackgroundTasks('wire-parent')).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
