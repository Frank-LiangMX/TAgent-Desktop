import { resolve } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'

/** pi-core file tools otherwise resolve relative paths against Electron's process.cwd(). */
export function bindWorkspaceFileTool(tool: AgentTool, cwd: string): AgentTool {
  if (!['Read', 'Write', 'Edit'].includes(tool.name)) return tool
  return {
    ...tool,
    execute: (id, params, signal, onUpdate) => {
      const input = params as Record<string, unknown> | undefined
      return tool.execute(id,
        typeof input?.path === 'string' ? { ...input, path: resolve(cwd, input.path) } : params,
        signal, onUpdate)
    },
  }
}
