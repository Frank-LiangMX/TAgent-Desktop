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

// 协作/执行形态（Chat / Work）
export * from './execution-mode'

// Ask 档位相关类型
export * from './ask'

// Agent Provider 适配器接口
export * from './agent-provider'

// TAgentMessage 中间表示（双核统一渲染层消息格式）
export * from './tagent-message'

// Files Changed 本轮 diff 审阅上下文（FilePathChip / FilePreviewPane 共用）
export * from './file-review'

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
export * from './mention'

// 命令注册表（command-registry 统一命令路由）
export * from './command'

// 内置终端（node-pty + xterm.js）
export * from './terminal'

// 用户档案（用户名 / 称呼）
export * from './user-profile'

// 渠道余额查询
export * from './balance'

// MoA 会诊预置（虚拟 modelId + 预置存储契约）
export * from './moa-preset'

// MoA 圆桌卡纯函数状态机（panel 推/渲染用）
export * from './moa-roundtable'

// MoA 圆桌讨论（多轮）纯函数状态机 + IR 类型
export * from './moa-discussion'

// MoA 历史注入纯函数（拼会话上下文块 + 议题前缀）
export * from './moa-history'

// MoA 落盘 shape 纯函数（汇总 final assistant SDKMessage 构造）
export * from './moa-persist'

// CLI 工人配置（本机 coding CLI 子代理后端；类型 + 校验 + seed + helpers）
export * from './cli-workers'

// 主会话无进展防循环（No-Progress Guard）公共类型契约
export * from './no-progress'
export * from './session-process'

// Agent 圆桌 / 班组 设置偏好（类型 + 默认 + 校验）
export * from './agent-discuss-crew-prefs'

// Collaboration Room 多人协作房间相关类型（Stage 1：房间壳 + 静态成员 + 静态消息）
export * from './collaboration-room'
export * from './collaboration-room-channels'
export * from './collaboration-a2a'
// S3.5-b 房间共享摘要（04 §6）：类型 + 有效发言/CAS 谓词 + 六段总结 prompt
export * from './collaboration-summary'
export * from './browser'
export * from './fusion-session'
export * from './fusion-session-legacy'
export * from './fusion-routing'
