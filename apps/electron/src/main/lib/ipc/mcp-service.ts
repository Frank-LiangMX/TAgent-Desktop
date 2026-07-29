/**
 * MCP 服务：注册 MCP IPC handler
 *
 * 用 @tagent/shared AGENT_IPC_CHANNELS 中已定义的 MCP 通道名。
 * 职责：读/写工作区 MCP 配置（mcp.json），测试连接（复用 @tagent/pi-core 真实探测）。
 */
import { ipcMain } from 'electron'
import { AGENT_IPC_CHANNELS } from '@tagent/shared'
import type { McpServerEntry, WorkspaceMcpConfig } from '@tagent/shared'
import {
  getMcpConfig,
  saveMcpConfig,
  upsertMcpServer,
  deleteMcpServer,
  setMcpLastTestResult,
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

    // 测试连接（真实探测：复用 @tagent/pi-core testMcpServer，顺带持久化 lastTestResult）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.TEST_MCP_SERVER,
      async (
        _e,
        args: { slug: string; name: string; entry: McpServerEntry }
      ): Promise<{ success: boolean; message: string }> => {
        const { slug, name, entry } = args
        // ESM-only 包延迟加载，避免主进程启动期阻塞
        const { testMcpServer } = await import('@tagent/pi-core')
        const result = await testMcpServer(name, entry)
        // 持久化最近测试结果（仅当该 server 已存在，避免给未保存草稿落盘）
        try {
          setMcpLastTestResult(slug, name, {
            success: result.success,
            message: result.message,
            timestamp: Date.now(),
          })
        } catch (err) {
          console.error('[MCP] 持久化测试结果失败:', err)
        }
        return { success: result.success, message: result.message }
      }
    )
  }
}
