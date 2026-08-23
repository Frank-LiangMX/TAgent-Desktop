/**
 * 配置/数据路径（从 TAgent config-paths.ts 精简搬移）
 *
 * 数据目录：~/.tagent/（dev 模式 ~/.tagent-dev/）
 * 见 CLAUDE.md "本地文件存储"。
 */
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'

let _configDirName: string | null = null

/**
 * 是否已打包。延迟 require electron，避免：
 * - CI `bun install --ignore-scripts` 未下载 electron 二进制时顶层 import 直接炸掉
 * - vitest / 纯 Node 单测环境无 Electron runtime
 *
 * 注意：不要 createRequire(import.meta.url)。esbuild 打 CJS 时会把 import.meta
 * 收成空对象（url=undefined），模块一加载就崩。esbuild 对 external:electron
 * 会保留 require('electron')，主进程 CJS 下可用。
 *
 * 返回 null 表示无法探测（与原先 try/catch 回落 `.tagent` 一致）。
 */
function isAppPackaged(): boolean | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    return Boolean(app?.isPackaged)
  } catch {
    return null
  }
}

/** 配置目录名：dev 模式 .tagent-dev，正式 .tagent */
export function getConfigDirName(): string {
  if (_configDirName) return _configDirName
  if (process.env.TAGENT_DEV === '1') {
    _configDirName = '.tagent-dev'
  } else {
    const packaged = isAppPackaged()
    if (packaged === null) {
      _configDirName = '.tagent'
    } else {
      _configDirName = packaged ? '.tagent' : '.tagent-dev'
    }
  }
  return _configDirName
}

/** 配置目录绝对路径：~/.tagent[-dev]/ */
export function getConfigDir(): string {
  const override = process.env.TAGENT_CONFIG_DIR?.trim()
  const dir = override ? resolve(override) : join(homedir(), getConfigDirName())
  // 首次安装时目录可能尚不存在；所有配置文件写入都依赖它先创建。
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Agent 会话索引：~/.tagent[-dev]/agent-sessions.json */
export function getAgentSessionsIndexPath(): string {
  return join(getConfigDir(), 'agent-sessions.json')
}

/** Agent 会话消息目录：~/.tagent[-dev]/agent-sessions/（不存在则建） */
export function getAgentSessionsDir(): string {
  const dir = join(getConfigDir(), 'agent-sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 指定会话的消息文件：~/.tagent[-dev]/agent-sessions/{id}.jsonl */
export function getAgentSessionMessagesPath(id: string): string {
  return join(getAgentSessionsDir(), `${id}.jsonl`)
}

/** 渠道配置文件：~/.tagent[-dev]/channels.json（apiKey 加密存储） */
export function getChannelsPath(): string {
  return join(getConfigDir(), 'channels.json')
}

/** 角色库：~/.tagent[-dev]/agent-roles.json */
export function getAgentRolesPath(): string {
  return join(getConfigDir(), 'agent-roles.json')
}

/** 角色商店 catalog 本地缓存：~/.tagent[-dev]/role-store-catalog-cache.json */
export function getRoleStoreCatalogPath(): string {
  return join(getConfigDir(), 'role-store-catalog-cache.json')
}

/** Bot 库：~/.tagent[-dev]/bots.json */
export function getBotProfilesPath(): string {
  return join(getConfigDir(), 'bots.json')
}

/** Bot 长期记忆：~/.tagent[-dev]/bot-memories.json */
export function getBotMemoriesPath(): string {
  return join(getConfigDir(), 'bot-memories.json')
}

/** 项目数据根目录：~/.tagent[-dev]/projects/ */
export function getProjectsDir(): string {
  const dir = join(getConfigDir(), 'projects')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 单个项目目录：~/.tagent[-dev]/projects/{sanitizedPath}/ */
export function getProjectDir(sanitizedPath: string): string {
  const dir = join(getProjectsDir(), sanitizedPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 项目内 SDK 会话 JSONL：~/.tagent[-dev]/projects/{sanitizedPath}/{sessionId}.jsonl
 * 仅供 SDK resume / 软重置压缩重写（可压缩、可分叉）。
 * 面板历史请用 getProjectMessagesPath。
 */
export function getProjectSessionPath(sanitizedPath: string, sessionId: string): string {
  return join(getProjectDir(sanitizedPath), `${sessionId}.jsonl`)
}

/**
 * 项目内面板消息 JSONL：~/.tagent[-dev]/projects/{sanitizedPath}/{sessionId}.messages.jsonl
 * 只追加、永不压缩。面板历史 / L-rag 原文 / 软重置读用户可见历史均读此文件。
 * Phase 1.2 与 SDK JSONL 分离（D5）。
 */
export function getProjectMessagesPath(sanitizedPath: string, sessionId: string): string {
  return join(getProjectDir(sanitizedPath), `${sessionId}.messages.jsonl`)
}

/**
 * 旧路径下的面板消息文件：~/.tagent[-dev]/agent-sessions/{id}.messages.jsonl
 * 无 workspaceId 的老会话兼容用。
 */
export function getAgentSessionPanelMessagesPath(id: string): string {
  return join(getAgentSessionsDir(), `${id}.messages.jsonl`)
}

/**
 * 项目内圆桌讨论落盘文件：~/.tagent[-dev]/projects/{sanitizedPath}/{sessionId}.moa-discussion.jsonl
 * 与面板消息 JSONL 同目录；一行一场（终态 panel 含全部 entries + summary）。
 * 重启/切会话时主进程读此文件重放为入口卡 + 讨论室回看（T8）。
 */
export function getProjectMoaDiscussionPath(sanitizedPath: string, sessionId: string): string {
  return join(getProjectDir(sanitizedPath), `${sessionId}.moa-discussion.jsonl`)
}

/**
 * 旧路径下的圆桌讨论落盘文件：~/.tagent[-dev]/agent-sessions/{id}.moa-discussion.jsonl
 * 无 workspaceId 的老会话兼容用。
 */
export function getAgentSessionMoaDiscussionPath(id: string): string {
  return join(getAgentSessionsDir(), `${id}.moa-discussion.jsonl`)
}

/** 项目记忆目录：~/.tagent[-dev]/projects/{sanitizedPath}/memory/ */
export function getProjectMemoryDir(sanitizedPath: string): string {
  const dir = join(getProjectDir(sanitizedPath), 'memory')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 用户档案文件：~/.tagent[-dev]/user-profile.json */
export function getUserProfilePath(): string {
  return join(getConfigDir(), 'user-profile.json')
}

/** MoA 会诊预置文件：~/.tagent[-dev]/moa-presets.json */
export function getMoaPresetsPath(): string {
  return join(getConfigDir(), 'moa-presets.json')
}

/** CLI 工人配置文件：~/.tagent[-dev]/cli-workers.json（本机 coding CLI 子代理后端） */
export function getCliWorkersPath(): string {
  return join(getConfigDir(), 'cli-workers.json')
}

/** 圆桌（agent-discuss）偏好文件：~/.tagent[-dev]/agent-discuss-prefs.json */
export function getAgentDiscussPrefsPath(): string {
  return join(getConfigDir(), 'agent-discuss-prefs.json')
}

/** 班组（agent-crew）偏好文件：~/.tagent[-dev]/agent-crew-prefs.json */
export function getAgentCrewPrefsPath(): string {
  return join(getConfigDir(), 'agent-crew-prefs.json')
}

/** 系统提示词配置：~/.tagent[-dev]/system-prompts.json */
export function getSystemPromptsPath(): string {
  return join(getConfigDir(), 'system-prompts.json')
}

/** 协作室数据目录：~/.tagent[-dev]/collaboration/（不存在则建） */
export function getCollaborationDir(): string {
  const dir = join(getConfigDir(), 'collaboration')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** RoomSession 权威快照索引：~/.tagent[-dev]/collaboration/fusion-room-snapshots.json */
export function getFusionRoomSnapshotsPath(): string {
  return join(getCollaborationDir(), 'fusion-room-snapshots.json')
}

/** RoomSession 邀请令牌索引：~/.tagent[-dev]/collaboration/fusion-room-invite-tokens.json */
export function getFusionRoomInviteTokensPath(): string {
  return join(getCollaborationDir(), 'fusion-room-invite-tokens.json')
}
/** 协作室房间索引：~/.tagent[-dev]/collaboration/rooms.json */
export function getCollaborationRoomsPath(): string {
  return join(getCollaborationDir(), 'rooms.json')
}

/** 协作室成员索引：~/.tagent[-dev]/collaboration/members.json */
export function getCollaborationMembersPath(): string {
  return join(getCollaborationDir(), 'members.json')
}

/** 协作室消息索引：~/.tagent[-dev]/collaboration/messages.json */
export function getCollaborationMessagesPath(): string {
  return join(getCollaborationDir(), 'messages.json')
}

export function getCollaborationEventsPath(): string {
  return join(getCollaborationDir(), 'events.json')
}

/** 协作室 run 索引：~/.tagent[-dev]/collaboration/runs.json */
export function getCollaborationRunsPath(): string {
  return join(getCollaborationDir(), 'runs.json')
}

/** 协作室 A2A 信箱索引：~/.tagent[-dev]/collaboration/mailbox.json（S4） */
export function getCollaborationMailboxPath(): string {
  return join(getCollaborationDir(), 'mailbox.json')
}

/** 协作室房间共享摘要索引：~/.tagent[-dev]/collaboration/summaries.json（S3.5-b） */
export function getCollaborationSummariesPath(): string {
  return join(getCollaborationDir(), 'summaries.json')
}

/** 协作室轻量 room task 索引：~/.tagent[-dev]/collaboration/room-tasks.json（S5） */
export function getCollaborationRoomTasksPath(): string {
  return join(getCollaborationDir(), 'room-tasks.json')
}

/** 协作室产物索引：~/.tagent[-dev]/collaboration/artifacts.json（S5 room_publish_artifact） */
export function getCollaborationArtifactsPath(): string {
  return join(getCollaborationDir(), 'artifacts.json')
}

/** 协作室服务工作区根目录：~/.tagent[-dev]/collaboration/room-workspaces/ */
export function getCollaborationRoomWorkspacesDir(): string {
  const dir = join(getCollaborationDir(), 'room-workspaces')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 指定协作室的服务工作区目录；roomId 只允许作为单层目录名使用。 */
export function getCollaborationRoomWorkspaceDir(roomId: string): string {
  const safeRoomId = roomId.trim().replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!safeRoomId) throw new Error('无效的协作室 ID')
  const dir = join(getCollaborationRoomWorkspacesDir(), safeRoomId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
/** 协作室用户审批请求索引：~/.tagent[-dev]/collaboration/user-approvals.json */
export function getCollaborationUserApprovalsPath(): string {
  return join(getCollaborationDir(), 'user-approvals.json')
}

/** 协作室成员配置模板：~/.tagent[-dev]/collaboration/member-presets.json */
export function getCollaborationMemberPresetsPath(): string {
  return join(getCollaborationDir(), 'member-presets.json')
}

/**
 * 打包版协作 / 网络显式闸门偏好：~/.tagent[-dev]/collaboration/fusion-room-network-prefs.json
 * 默认全关（enableCollaboration=false、enableNetworkListen=false）；只存两个布尔，
 * 不存在明文公网 / 不安全监听开关。见 fusion-room-network-prefs.ts。
 */
export function getFusionRoomNetworkPrefsPath(): string {
  return join(getCollaborationDir(), 'fusion-room-network-prefs.json')
}
