/**
 * 记忆系统 IPC（Phase 2.3）
 *
 * 注册 MEMORY_IPC_CHANNELS + AGENT_IPC_CHANNELS 记忆相关通道。
 * Graph 数据由 learning-graph-service 从已整理记忆与历史会话装配。
 */
import { ipcMain } from 'electron'
import {
  AGENT_IPC_CHANNELS,
  MEMORY_IPC_CHANNELS,
  type GraphPayload,
} from '@tagent/shared'
import {
  memoryLayerService,
  nudgeService,
  readStageQueue,
  acceptAll,
  rejectAll,
  removeFromStage,
  type MemoryMode,
} from '../memory'

export class MemoryService {
  private constructor() {}

  static create(): MemoryService {
    const svc = new MemoryService()
    svc.registerIpc()
    return svc
  }

  private registerIpc(): void {
    // ===== 记忆层 =====
    ipcMain.handle(AGENT_IPC_CHANNELS.INIT_MEMORY_LAYERS, async () => {
      return memoryLayerService.initialize()
    })

    ipcMain.handle(AGENT_IPC_CHANNELS.GET_MEMORY_STATS, async (_e, mode: MemoryMode) => {
      return memoryLayerService.getStats(mode)
    })

    ipcMain.handle(
      AGENT_IPC_CHANNELS.SEARCH_MEMORY_SESSIONS,
      async (_e, mode: MemoryMode, query: string, limit?: number) => {
        return memoryLayerService.searchSessions(mode, query, limit)
      },
    )

    ipcMain.handle(
      AGENT_IPC_CHANNELS.LIST_RECENT_MEMORY_SESSIONS,
      async (_e, mode: MemoryMode, limit?: number) => {
        return memoryLayerService.listRecentSessions(mode, limit)
      },
    )

    ipcMain.handle(
      AGENT_IPC_CHANNELS.GET_MEMORY_MD_CONTENT,
      async (_e, mode: MemoryMode, layer: 'L0' | 'L1' | 'L2' | 'L5') => {
        return memoryLayerService.getMdContent(mode, layer)
      },
    )

    ipcMain.handle(
      AGENT_IPC_CHANNELS.GET_MEMORY_CORRECTIONS,
      async (_e, mode: MemoryMode, limit?: number) => {
        return memoryLayerService.getCorrections(mode, limit)
      },
    )

    // ===== Nudge =====
    ipcMain.handle(
      MEMORY_IPC_CHANNELS.GET_PENDING_NUDGES,
      async (_e, sessionId: string) => {
        return nudgeService.getPendingNudges(sessionId)
      },
    )

    ipcMain.handle(
      MEMORY_IPC_CHANNELS.RESPOND_NUDGE,
      async (
        _e,
        args: {
          sessionId: string
          nudgeId: string
          action: 'accept' | 'reject' | 'defer'
          mode: MemoryMode
        },
      ) => {
        await nudgeService.handleNudgeResponse(
          args.sessionId,
          args.nudgeId,
          args.action,
          args.mode,
        )
        return { ok: true }
      },
    )

    // ===== Stage 队列 =====
    ipcMain.handle(
      MEMORY_IPC_CHANNELS.GET_STAGE_QUEUE,
      async (_e, mode: MemoryMode) => {
        return readStageQueue(mode)
      },
    )

    ipcMain.handle(
      MEMORY_IPC_CHANNELS.ACCEPT_STAGE_ALL,
      async (_e, mode: MemoryMode) => {
        // 先写层，成功后再清空队列；避免 accept 只移除待审批条目却没有沉淀。
        const entries = readStageQueue(mode)
        for (const entry of entries) {
          await nudgeService.writeStageEntryToLayer(entry, mode)
        }
        acceptAll(mode)
        return { ok: true, accepted: entries.length }
      },
    )

    ipcMain.handle(
      MEMORY_IPC_CHANNELS.REJECT_STAGE_ALL,
      async (_e, mode: MemoryMode) => {
        return rejectAll(mode)
      },
    )

    ipcMain.handle(
      MEMORY_IPC_CHANNELS.ACCEPT_STAGE_ONE,
      async (_e, args: { mode: MemoryMode; id: string }) => {
        const entry = readStageQueue(args.mode).find((candidate) => candidate.id === args.id)
        if (!entry) return { ok: false, error: '待审批条目不存在' }
        await nudgeService.writeStageEntryToLayer(entry, args.mode)
        removeFromStage(args.mode, args.id)
        return { ok: true }
      },
    )

    ipcMain.handle(
      MEMORY_IPC_CHANNELS.REJECT_STAGE_ONE,
      async (_e, args: { mode: MemoryMode; id: string }) => {
        removeFromStage(args.mode, args.id)
        return { ok: true }
      },
    )

    // ===== Graph =====
    ipcMain.handle(
      MEMORY_IPC_CHANNELS.GET_GRAPH_DATA,
      async (_e, mode: MemoryMode, workspaceSlug?: string): Promise<GraphPayload> => {
        try {
          const { buildGraphPayload } = await import('../memory/learning-graph-service')
          return buildGraphPayload(mode, workspaceSlug)
        } catch (err) {
          console.warn('[memory-service] buildGraphPayload failed:', err)
          return {
            nodes: [],
            edges: [],
            stats: { memoryNodes: 0, sessionNodes: 0, edges: 0 },
          }
        }
      },
    )
  }
}
