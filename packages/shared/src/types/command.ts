/**
 * 命令注册表相关类型与 IPC 通道常量
 *
 * TAgent 桌面应用的统一命令路由基础设施。所有 UI 按钮 / 命令面板触发的动作
 * 均通过 `command-registry` 注册，renderer 经 IPC 调 main 进程执行。
 *
 * 设计目标：
 * - 统一命令入口（避免每个按钮各写一套 IPC 调用）
 * - 为 v1.6 Cmd+K 全局命令面板预留扩展点
 * - 不引入 slash command 文本语法（与现有 `/` = TipTap Mention skill 触发冲突）
 *
 * 详见 CLAUDE.md「能力新增 Footprint Ladder」段。
 */

/** 命令分类 */
export type CommandCategory = 'desktop' | 'agent' | 'model'

/** 命令上下文：handler 执行时拿到的运行时信息 */
export interface CommandContext {
  /** 当前会话 ID（如有） */
  sessionId?: string
  /** 当前会话所属工作区 slug（如有） */
  workspaceSlug?: string
  /** 当前模式 */
  mode?: 'general' | 'ta'
  /** 命令特定参数（handler 内部按需 cast） */
  args?: unknown
}

/**
 * 命令 IPC 通道常量
 *
 * 同步 4 处：`@tagent/shared` 类型 → `main/ipc.ts` 处理器 → `preload/index.ts` 桥接 → renderer 调用
 */
export const COMMAND_IPC_CHANNELS = {
  /** 执行指定命令 */
  RUN_COMMAND: 'command:run',
  /** 列出已注册命令（可按 category 过滤） */
  LIST_COMMANDS: 'command:list',
} as const

/** RUN_COMMAND 通道的请求载荷 */
export interface RunCommandInput {
  /** 命令 ID */
  commandId: string
  /** 命令上下文 */
  context: CommandContext
}

/** LIST_COMMANDS 通道的请求载荷 */
export interface ListCommandsInput {
  /** 可选分类过滤 */
  category?: CommandCategory
}

/** LIST_COMMANDS 通道的响应：命令元信息列表（不含 handler） */
export interface CommandMeta {
  id: string
  name: string
  description: string
  category: CommandCategory
  shortcut?: string
  icon?: string
}
