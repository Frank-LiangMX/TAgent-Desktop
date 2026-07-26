/**
 * 渠道服务：注册 CHANNEL_IPC_CHANNELS handler
 *
 * 渠道 CRUD + apiKey 解密 + 连接测试/拉模型（占位）。
 * kscc-internal 内置渠道：不可删，TEST 走 resolveKsccPath 检测。
 *
 * 见 shared/types/channel.ts 的 CHANNEL_IPC_CHANNELS。
 */
import { ipcMain } from 'electron'
import {
  CHANNEL_IPC_CHANNELS,
  type Channel,
  type ChannelCreateInput,
  type ChannelUpdateInput,
  type ChannelTestResult,
  type FetchModelsInput,
  type FetchModelsResult,
  type ProviderType,
} from '@tagent/shared'
import {
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  getDecryptedApiKey,
  getChannel,
} from '../channel/channel-store'
import { getDefaultModelsForProvider } from '../channel/default-models'
import { resolveKsccPath } from '../adapters/claude/kscc-path'

export class ChannelService {
  private constructor() {}

  static create(): ChannelService {
    const svc = new ChannelService()
    svc.registerIpc()
    return svc
  }

  private registerIpc(): void {
    // 列渠道（apiKey 保持加密）
    ipcMain.handle(CHANNEL_IPC_CHANNELS.LIST, async (): Promise<Channel[]> => {
      return listChannels()
    })

    // 创建渠道
    ipcMain.handle(
      CHANNEL_IPC_CHANNELS.CREATE,
      async (_e, input: ChannelCreateInput): Promise<Channel> => {
        return createChannel(input)
      }
    )

    // 更新渠道
    ipcMain.handle(
      CHANNEL_IPC_CHANNELS.UPDATE,
      async (_e, args: { id: string; patch: ChannelUpdateInput }): Promise<Channel | undefined> => {
        return updateChannel(args.id, args.patch)
      }
    )

    // 删除渠道（kscc-internal 不可删）
    ipcMain.handle(
      CHANNEL_IPC_CHANNELS.DELETE,
      async (_e, id: string): Promise<{ ok: boolean; error?: string }> => {
        return deleteChannel(id)
      }
    )

    // 解密 apiKey（渲染层编辑时回填用；kscc 返回空串）
    ipcMain.handle(
      CHANNEL_IPC_CHANNELS.DECRYPT_KEY,
      async (_e, id: string): Promise<string> => {
        return getDecryptedApiKey(id)
      }
    )

    // 测试连接（占位：kscc 走 resolveKsccPath，外部等 Pi 核接入后实装）
    ipcMain.handle(
      CHANNEL_IPC_CHANNELS.TEST,
      async (_e, id: string): Promise<ChannelTestResult> => {
        return this.testChannel(id)
      }
    )

    // 拉取模型（占位：返回内置默认模型列表，真实 HTTP 拉取待 Pi 核接入）
    ipcMain.handle(
      CHANNEL_IPC_CHANNELS.FETCH_MODELS,
      async (_e, input: FetchModelsInput): Promise<FetchModelsResult> => {
        const models = getDefaultModelsForProvider(input.provider)
        return {
          success: true,
          message: models.length > 0 ? '内置默认模型' : '该 Provider 无预填模型，请手动添加',
          models,
        }
      }
    )
  }

  /** 测试渠道连接 */
  private async testChannel(id: string): Promise<ChannelTestResult> {
    const ch = getChannel(id)
    if (ch?.provider === 'kscc-internal') {
      const ksccPath = resolveKsccPath()
      if (!ksccPath) {
        return { success: false, message: '未检测到 kscc 命令，请先安装 kscc（内网渠道）' }
      }
      return { success: true, message: `kscc 就绪：${ksccPath}` }
    }
    // 外部渠道：真实连接测试待 Pi 核接入后实装
    return { success: true, message: '占位（Pi 核接入后实装真实连接测试）' }
  }
}

/** 重新导出 ProviderType 供外部用 */
export type { ProviderType }
