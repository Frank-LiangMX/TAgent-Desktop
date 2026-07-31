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
  if (override) return resolve(override)
  return join(homedir(), getConfigDirName())
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

/** 项目记忆目录：~/.tagent[-dev]/projects/{sanitizedPath}/memory/ */
export function getProjectMemoryDir(sanitizedPath: string): string {
  const dir = join(getProjectDir(sanitizedPath), 'memory')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
