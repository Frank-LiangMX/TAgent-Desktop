import { resolve } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { describe, expect, it, vi } from 'vitest'
import { bindWorkspaceFileTool } from './workspace-file-tool'

describe('workspace file tool', () => {
  it.each(['Read', 'Write', 'Edit'])('binds %s relative paths without changing process cwd or caller arguments', async name => {
    const execute = vi.fn(async () => ({ content: [], details: {} }))
    const tool = { name, execute } as unknown as AgentTool
    const params = { path: 'src/main.ts', content: 'example' }
    const signal = new AbortController().signal
    const cwd = process.cwd()
    const workspace = resolve(cwd, 'fixture-workspace')
    await bindWorkspaceFileTool(tool, workspace).execute('call', params, signal)
    expect(execute).toHaveBeenCalledWith('call', { ...params, path: resolve(workspace, params.path) }, signal, undefined)
    expect(params.path).toBe('src/main.ts')
    expect(process.cwd()).toBe(cwd)
  })
  it('does not rewrite third-party or Bash tools', () => {
    const tool = { name: 'Bash' } as AgentTool
    expect(bindWorkspaceFileTool(tool, 'unused')).toBe(tool)
  })
})
