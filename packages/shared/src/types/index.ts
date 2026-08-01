/**
 * Shared type definitions for TAgent
 */

// Placeholder types - will be expanded as needed
export interface Workspace {
  id: string
  name: string
  path: string
}

// 运行时相关类型
export * from './runtime'

// 渠道（AI 供应商）相关类型
export * from './channel'

// 代理配置相关类型
export * from './proxy'

// Chat 相关类型
export * from './chat'

// Agent 相关类型
export * from './agent'

// Ask 档位相关类型
export * from './ask'

// Agent Provider 适配器接口
export * from './agent-provider'

// TAgentMessage 中间表示（双核统一渲染层消息格式）
export * from './tagent-message'

// 环境检测相关类型
export * from './environment'

// 第三方安装包（Git、Node.js 等）相关类型
export * from './installer'

// GitHub Release 相关类型
export * from './github'

// 系统提示词相关类型
export * from './system-prompt'

// Chat 工具（function calling）相关类型
export * from './chat-tool'

// 飞书集成相关类型
export * from './feishu'

// 钉钉集成相关类型
export * from './dingtalk'

// 微信集成相关类型
export * from './wechat'

// WPS 协作集成相关类型
export * from './wps'

// Pipeline 流水线相关类型
export * from './pipeline'

// 使用统计相关类型
export * from './usage-stats'

// Context Usage 分项
export * from './context-usage'

// Automation 定时任务相关类型
export * from './automation'

// Draft 需求草稿相关类型
export * from './draft'

// Kanban 任务看板编排相关类型
export * from './kanban'
export * from './kanban-ipc'

// Agent 角色库（看板 worker 角色定义）
export * from './agent-role'

// 命令注册表（command-registry 统一命令路由）
export * from './command'

// 内置终端（node-pty + xterm.js）
export * from './terminal'

// 用户档案（用户名 / 称呼）
export * from './user-profile'

// 渠道余额查询
export * from './balance'
