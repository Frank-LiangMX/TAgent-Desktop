/**
 * 渠道服务：注册 CHANNEL_IPC_CHANNELS handler
 *
 * 渠道 CRUD + 连接测试（HTTP）/ 拉模型（HTTP）；apiKey 仅在主进程解密。
 * kscc-internal / codex-internal 本机渠道：不可删，TEST 走本机 Runtime 检测。
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
  type FetchModelsForChannelInput,
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
import { testChannelConnection, fetchModelsFromProvider } from '../channel/channel-tester'

export class ChannelService {
  private constructor() {}

  static create(): ChannelService {
    const svc = new ChannelService()
    svc.registerIpc()
    return svc
  }

  private registerIpc(): void {
    const fetchModelsWithFallback = async (input: FetchModelsInput): Promise<FetchModelsResult> => {
      const result = await fetchModelsFromProvider(input)
      if (result.success && result.models.length > 0) return result
      const fallback = getDefaultModelsForProvider(input.provider)
      return {
        success: result.success,
        message: result.models.length === 0
          ? (fallback.length > 0 ? `${result.message}；使用内置预设（${fallback.length} 个）` : result.message)
          : result.message,
        models: fallback.length > 0 ? fallback : result.models,
      }
    }

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

    // 删除渠道（本机 Runtime 不可删）
    ipcMain.handle(
      CHANNEL_IPC_CHANNELS.DELETE,
      async (_e, id: string): Promise<{ ok: boolean; error?: string }> => {
        return deleteChannel(id)
      }
    )

    // 测试连接（kscc 走 resolveKsccPath，外部走真实 HTTP 请求）
    ipcMain.handle(
      CHANNEL_IPC_CHANNELS.TEST,
      async (_e, id: string): Promise<ChannelTestResult> => {
        const ch = getChannel(id)
        if (!ch) return { success: false, message: '渠道不存在' }
        const apiKey = getDecryptedApiKey(id)
        return testChannelConnection(ch, apiKey)
      }
    )

    // 拉取模型（尝试从 provider API 拉取，失败回退到内置默认列表）
    ipcMain.handle(
      CHANNEL_IPC_CHANNELS.FETCH_MODELS,
      async (_e, input: FetchModelsInput): Promise<FetchModelsResult> => {
        return fetchModelsWithFallback(input)
      }
    )

    // 编辑已保存渠道时在主进程解密凭据，明文 API Key 不进入渲染进程
    ipcMain.handle(
      CHANNEL_IPC_CHANNELS.FETCH_MODELS_FOR_CHANNEL,
      async (_e, input: FetchModelsForChannelInput): Promise<FetchModelsResult> => {
        const channel = getChannel(input.channelId)
        if (!channel) return { success: false, message: '渠道不存在', models: [] }
        if (
          channel.provider === 'kscc-internal' ||
          channel.provider === 'codex-internal'
        ) {
          return { success: false, message: '内置渠道不支持远程同步模型', models: channel.models }
        }
        const apiKey = getDecryptedApiKey(channel.id)
        if (!apiKey) {
          return { success: false, message: '已保存的 API Key 无法解密，请重新输入并保存', models: [] }
        }
        return fetchModelsWithFallback({
          provider: channel.provider,
          baseUrl: channel.baseUrl,
          apiKey,
        })
      }
    )
  }

}

/** 重新导出 ProviderType 供外部用 */
export type { ProviderType }
