/**
 * Pipeline 相关类型定义
 *
 * 流水线用于执行 TA 工作流中的批处理任务，如：
 * - 批量重命名资产
 * - 纹理压缩
 * - 资产导入
 * - 命名检查
 * 等
 */

/**
 * 流水线运行状态
 */
export type PipelineRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * 流水线运行记录
 */
export interface PipelineRun {
  /** 唯一标识 */
  id: string
  /** 流水线名称 */
  name: string
  /** 运行状态 */
  status: PipelineRunStatus
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 开始时间（毫秒时间戳，pending 时为 null） */
  startTime: number | null
  /** 结束时间（毫秒时间戳，运行中时为 null） */
  endTime: number | null
  /** 已处理的项目数量 */
  itemsProcessed: number
  /** 总项目数量（未知时为 null） */
  itemsTotal: number | null
  /** 错误信息（失败时） */
  error: string | null
  /** 流水线类型（用于分类） */
  type: string
  /** 触发来源 */
  triggeredBy: 'user' | 'agent' | 'scheduled'
  /** 关联的 Agent 会话 ID（如果是 Agent 触发） */
  sessionId?: string
  /** 元数据（可扩展） */
  metadata?: Record<string, unknown>
}

/**
 * 创建流水线请求
 */
export interface CreatePipelineRunRequest {
  name: string
  type: string
  itemsTotal?: number
  triggeredBy?: 'user' | 'agent' | 'scheduled'
  sessionId?: string
  metadata?: Record<string, unknown>
}

/**
 * 更新流水线请求
 */
export interface UpdatePipelineRunRequest {
  status?: PipelineRunStatus
  itemsProcessed?: number
  itemsTotal?: number
  error?: string
  metadata?: Record<string, unknown>
}

/**
 * 流水线统计摘要
 */
export interface PipelineSummary {
  running: number
  pending: number
  completed: number
  failed: number
  cancelled: number
  total: number
}

/**
 * 流水线列表查询参数
 */
export interface PipelineListQuery {
  status?: PipelineRunStatus[]
  type?: string[]
  limit?: number
  offset?: number
}

/**
 * Pipeline 相关 IPC 通道常量
 */
export const PIPELINE_IPC_CHANNELS = {
  /** 获取流水线列表 */
  LIST: 'pipeline:list',
  /** 获取单个流水线详情 */
  GET: 'pipeline:get',
  /** 创建流水线 */
  CREATE: 'pipeline:create',
  /** 更新流水线状态 */
  UPDATE: 'pipeline:update',
  /** 取消/删除流水线 */
  CANCEL: 'pipeline:cancel',
  /** 获取流水线统计摘要 */
  SUMMARY: 'pipeline:summary',
  /** 清理已完成的流水线记录 */
  CLEANUP: 'pipeline:cleanup',
} as const

export type PipelineIpcChannel = (typeof PIPELINE_IPC_CHANNELS)[keyof typeof PIPELINE_IPC_CHANNELS]
