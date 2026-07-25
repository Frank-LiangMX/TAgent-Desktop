/** Context 分项（与 SDK categories 对齐） */
export interface ContextUsageCategory {
  name: string
  tokens: number
  color: string
  isDeferred?: boolean
}

export interface ContextUsageMemoryFile {
  path: string
  type: string
  tokens: number
}

export interface ContextUsageMcpTool {
  name: string
  serverName: string
  tokens: number
  isLoaded?: boolean
}

export interface ContextUsageSystemTool {
  name: string
  tokens: number
}

export interface ContextUsageSystemPromptSection {
  name: string
  tokens: number
}

export interface ContextUsageAgentEntry {
  agentType: string
  source: string
  tokens: number
}

export interface ContextUsageSkillsInfo {
  totalSkills: number
  includedSkills: number
  tokens: number
  skillFrontmatter: Array<{ name: string; source: string; tokens: number }>
}

export interface ContextUsageMessageBreakdown {
  toolCallTokens: number
  toolResultTokens: number
  attachmentTokens: number
  assistantMessageTokens: number
  userMessageTokens: number
  redirectedContextTokens?: number
  unattributedTokens?: number
  toolCallsByType: Array<{ name: string; callTokens: number; resultTokens: number }>
  attachmentsByType?: Array<{ name: string; tokens: number }>
}

export interface ContextUsageApiUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/** Context Usage 完整快照（SDK getContextUsage 映射） */
export interface ContextUsageSnapshot {
  categories: ContextUsageCategory[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
  isAutoCompactEnabled: boolean
  autoCompactThreshold?: number
  memoryFiles: ContextUsageMemoryFile[]
  mcpTools: ContextUsageMcpTool[]
  systemTools?: ContextUsageSystemTool[]
  systemPromptSections?: ContextUsageSystemPromptSection[]
  agents: ContextUsageAgentEntry[]
  skills?: ContextUsageSkillsInfo
  messageBreakdown?: ContextUsageMessageBreakdown
  apiUsage: ContextUsageApiUsage | null
  /** 拉取时间戳（客户端填入） */
  fetchedAt: number
}

export type ContextUsageErrorCode =
  | 'NO_ACTIVE_QUERY'
  | 'NO_CACHE'
  | 'SDK_ERROR'
  | 'SESSION_NOT_FOUND'
  | 'UNSUPPORTED'

export interface GetContextUsageResult {
  ok: true
  snapshot: ContextUsageSnapshot
}

export interface GetContextUsageError {
  ok: false
  code: ContextUsageErrorCode
  message: string
}

export type GetContextUsageResponse = GetContextUsageResult | GetContextUsageError
