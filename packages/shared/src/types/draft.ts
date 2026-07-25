/**
 * Draft Types — 结构化需求草稿数据模型
 *
 * 从 Kun 的 SDD 系统简化而来，适配 TAgent 通用 AI 任务场景。
 * 不需要 INVEST/3C 等专业框架，只需要标题 + 描述 + 验收标准。
 */

/** 草稿生命周期：draft → ready → executing → done → verified */
export type DraftStatus = 'draft' | 'ready' | 'executing' | 'done' | 'verified'

/** 验收标准条目 */
export interface AcceptanceCriterion {
  id: string
  text: string
  checked: boolean
}

/** 需求块 — 比 Kun 的 R-n 块更轻量 */
export interface RequirementBlock {
  id: string
  label: string // "R-1", "R-2" 自增
  title: string
  description: string
  acceptanceCriteria: AcceptanceCriterion[]
  status?: DraftStatus // 块级状态覆盖
}

/** 完整草稿文档 */
export interface DraftDocument {
  id: string
  title: string
  workspaceId?: string // 关联工作区
  mode?: 'general' | 'ta'
  context: string // 自由形式背景（TipTap HTML）
  requirements: RequirementBlock[]
  status: DraftStatus
  agentSessionId?: string // 升级后关联的 Agent 会话
  createdAt: number
  updatedAt: number
}

export const DRAFT_IPC_CHANNELS = {
  LIST: 'draft:list',
  GET: 'draft:get',
  CREATE: 'draft:create',
  UPDATE: 'draft:update',
  DELETE: 'draft:delete',
  MIGRATE_LEGACY: 'draft:migrate-legacy',
} as const
