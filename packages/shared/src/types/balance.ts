/**
 * 渠道余额查询
 *
 * 会话 token 栏左侧展示当前渠道账户余额（目前支持 DeepSeek）。
 * 实现为轻量「余额/金额」模型：查询供应商官方接口，返回可展示金额文本。
 */

/** 渠道余额查询结果 */
export interface ChannelBalanceResult {
  /** 该渠道是否支持余额查询 */
  supported: boolean
  /** 供应商类型（deepseek 等） */
  provider: string
  /** 展示标签（如「余额」） */
  label?: string
  /** 剩余金额展示文本（如「¥110.00」） */
  balanceLabel?: string
  /** 数值型余额 */
  balance?: number
  /** 币种（CNY / USD 等） */
  currency?: string
  /** 查询失败或不支持时的用户可读原因 */
  message?: string
  /** 查询时间戳（毫秒） */
  updatedAt: number
}

/** 渠道余额 IPC 通道 */
export const BALANCE_IPC_CHANNELS = {
  /** 按渠道 ID 查询余额 */
  GET: 'balance:get',
} as const
