/**
 * MCP 服务：注册 MCP IPC handler
 *
 * 用 @tagent/shared AGENT_IPC_CHANNELS 中已定义的 MCP 通道名。
 * 职责：读/写工作区 MCP 配置（mcp.json），测试连接（占位）。
 */
import { ipcMain } from 'electron'
import { AGENT_IPC_CHANNELS } from '@tagent/shared'
import type { McpServerEntry, WorkspaceMcpConfig } from '@tagent/shared'
import {
  getMcpConfig,
  saveMcpConfig,
  upsertMcpServer,
  deleteMcpServer,
} from '../mcp/mcp-store'

export class McpService {
  private constructor() {}

  static create(): McpService {
    const svc = new McpService()
    svc.registerIpc()
    return svc
  }

  private registerIpc(): void {
    // 读工作区 MCP 配置
    ipcMain.handle(AGENT_IPC_CHANNELS.GET_MCP_CONFIG, async (_e, slug: string): Promise<WorkspaceMcpConfig> => {
      return getMcpConfig(slug)
    })

    // 全量保存工作区 MCP 配置
    ipcMain.handle(
      AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG,
      async (_e, args: { slug: string; config: WorkspaceMcpConfig }): Promise<{ ok: boolean }> => {
        saveMcpConfig(args.slug, args.config)
        return { ok: true }
      }
    )

    // 新增/改单个 server
    ipcMain.handle(
      AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG + ':upsert',
      async (_e, args: { slug: string; name: string; entry: McpServerEntry }): Promise<WorkspaceMcpConfig> => {
        return upsertMcpServer(args.slug, args.name, args.entry)
      }
    )

    // 删除单个 server
    ipcMain.handle(
      AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG + ':delete',
      async (_e, args: { slug: string; name: string }): Promise<{ ok: boolean; error?: string }> => {
        return deleteMcpServer(args.slug, args.name)
      }
    )

    // 测试连接（占位：stdio 检测命令是否存在，http/sse 暂占位）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.TEST_MCP_SERVER,
      async (_e, _entry: McpServerEntry): Promise<{ success: boolean; message: string }> => {
        return { success: true, message: '占位（真实连接测试待接）' }
      }
    )
  }
}
