/**
 * 渠道余额服务：注册 BALANCE 相关 IPC handler
 *
 * 使用 @tagent/shared 的 BALANCE_IPC_CHANNELS。
 * - GET：按渠道 ID 查询账户余额
 *
 * 见 shared/types/balance.ts。
 */
import { ipcMain } from 'electron'
import { BALANCE_IPC_CHANNELS } from '@tagent/shared'
import type { ChannelBalanceResult } from '@tagent/shared'
import { queryChannelBalance } from '../balance/balance-service'

export class BalanceService {
  static create(): BalanceService {
    const svc = new BalanceService()
    svc.registerIpc()
    return svc
  }

  /** 注册 IPC handler */
  private registerIpc(): void {
    ipcMain.handle(
      BALANCE_IPC_CHANNELS.GET,
      async (_e, channelId: string): Promise<ChannelBalanceResult> => {
        return queryChannelBalance(channelId)
      },
    )
  }
}
