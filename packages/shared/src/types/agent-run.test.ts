import { describe, expect, it } from 'vitest'
import {
  createAgentRunRecord,
  createAgentRunSpec,
  validateAgentRunSpec,
  type AgentRunSpec,
} from './agent-run'

const validSpec: AgentRunSpec = {
  schemaVersion: 1,
  runId: 'run-1',
  agentId: 'pi-researcher',
  runtime: 'pi-in-process',
  prompt: '分析这个项目',
  workspace: 'F:/workspace/demo',
  permission: 'read-only',
  configRevision: 'rev-1',
  createdAt: 1_700_000_000_000,
}

describe('AgentRunSpec 契约', () => {
  it('拒绝非法 runtime', () => {
    expect(validateAgentRunSpec({ ...validSpec, runtime: 'unknown-runtime' })).not.toBeNull()
  })

  it('拒绝空的运行必填字段', () => {
    for (const field of ['runId', 'agentId', 'workspace', 'configRevision']) {
      expect(validateAgentRunSpec({ ...validSpec, [field]: '' }), field).not.toBeNull()
    }
  })

  it('缺失可选配置时使用稳定的运行记录默认值', () => {
    const record = createAgentRunRecord(createAgentRunSpec(validSpec))

    expect(record.status).toBe('queued')
    expect(record.events).toEqual([])
    expect(record.spec.toolNames).toBeUndefined()
    expect(record.spec.skillIds).toBeUndefined()
  })

  it('创建快照时不把 API Key 带入结果', () => {
    const input = {
      ...validSpec,
      apiKey: 'must-not-persist',
      channel: { id: 'channel-1', apiKey: 'must-not-persist' },
    } as AgentRunSpec & Record<string, unknown>

    const snapshot = createAgentRunSpec(input)
    expect(snapshot).not.toHaveProperty('apiKey')
    expect(snapshot).not.toHaveProperty('channel')
    expect(JSON.stringify(snapshot)).not.toContain('must-not-persist')
  })
})
