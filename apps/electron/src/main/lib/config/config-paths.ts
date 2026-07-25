/**
 * 配置/数据路径（从 TAgent config-paths.ts 精简搬移）
 *
 * 数据目录：~/.tagent/（dev 模式 ~/.tagent-dev/）
 * 见 CLAUDE.md "本地文件存储"。
 */
import { app } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'

let _configDirName: string | null = null

/** 配置目录名：dev 模式 .tagent-dev，正式 .tagent */
export function getConfigDirName(): string {
  if (_configDirName) return _configDirName
  if (process.env.TAGENT_DEV === '1') {
    _configDirName = '.tagent-dev'
  } else {
    try {
      _configDirName = app.isPackaged ? '.tagent' : '.tagent-dev'
    } catch {
      _configDirName = '.tagent'
    }
  }
  return _configDirName
}

/** 配置目录绝对路径：~/.tagent[-dev]/ */
export function getConfigDir(): string {
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
