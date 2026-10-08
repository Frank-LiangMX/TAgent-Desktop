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
vi.mock('../../agent/agent-crew-prefs', () => ({ readAgentCrewPrefs: () => ({ maxParallelWorkers: 1 }) }))
vi.mock('../../agent/official-delegated-agent', () => ({ runOfficialDelegatedAgent: () => { throw new Error('native runtime forbidden in loopback test') } }))
vi.mock('../../agent/subagent-definitions', () => ({ buildBuiltinSubagentDefinitions: () => ({ explorer: { prompt: 'Reply briefly.', tools: [] } }), resolveSubagentDefinition: () => undefined }))
vi.mock('../../agent/session-process-registry', () => ({ bashHooksForSession: () => undefined }))

import { createTaskTool } from './subagent-task-tool'
import { countDelegationSlots } from '../../agent/delegation-capacity'
import { countRunningBackgroundTasks } from '../../agent/background-delegation-service'
afterAll(() => rmSync(configDir, { recursive: true, force: true }))

describe('delegated Pi API wire', () => {
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
      models: ['parent-model', 'child-model', 'bad-model'].map(model => ({ id: model, name: model, enabled: true })),
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
      expect(countDelegationSlots('wire-parent')).toBe(0)
      expect(countRunningBackgroundTasks('wire-parent')).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
