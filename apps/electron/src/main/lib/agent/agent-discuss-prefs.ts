/**
 * Agent 圆桌（agent-discuss）用户偏好（主进程落盘）
 *
 * 路径：~/.tagent[-dev]/agent-discuss-prefs.json（与其它 tagent 配置同根）。
 * 读写均经 atomic-json（损坏自愈 + 原子写）。
 * 读：缺失 / 损坏 / 结构非法 → 返回默认（不写盘）。
 * 写：整单校验（`validateAgentDiscussPrefs`），非法即抛中文错、不脏写盘
 * （与 cli-workers-service 同口径，SPEC 04 §2.2）。
 *
 * 本期：仅落盘 + UI；`maxAgentMentionDepth` 运行时闸暂为 stub
 * （见 docs/dev/moa-roundtable/IMPLEMENT-AGENT-DISCUSS-CREW-SETTINGS-FINDINGS.md）。
 */
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { getAgentDiscussPrefsPath } from '../config/config-paths'
import {
  AGENT_DISCUSS_PREFS_DEFAULT,
  isValidAgentDiscussPrefs,
  sanitizeAgentDiscussPrefs,
  validateAgentDiscussPrefs,
  type AgentDiscussPrefs,
} from '@tagent/shared'

/**
 * 读圆桌偏好（纯读：缺失/损坏/非法 → 内存默认，不写盘）。
 * 合法则剥离为已知字段后返回（丢弃未知字段）。
 */
export function readAgentDiscussPrefs(): AgentDiscussPrefs {
  const parsed = readJsonSafe<unknown>(getAgentDiscussPrefsPath(), null)
  if (!isValidAgentDiscussPrefs(parsed)) {
    return { ...AGENT_DISCUSS_PREFS_DEFAULT }
  }
  return sanitizeAgentDiscussPrefs(parsed)
}

/**
 * 写入整份圆桌偏好（覆盖式原子写）。
 * 整单校验失败（结构非法 / 字段越界 / 类型不符）→ 抛中文错、**不写盘**。
 * 合法则剥离为已知字段后原子写，丢弃未知字段。
 * 设置页保存 IPC（`agent:set-discuss-prefs`）经此函数；调用方捕获错误回显给用户。
 */
export function writeAgentDiscussPrefs(prefs: unknown): AgentDiscussPrefs {
  const err = validateAgentDiscussPrefs(prefs)
  if (err) throw new Error(err)
  const clean = sanitizeAgentDiscussPrefs(prefs as AgentDiscussPrefs)
  writeJsonAtomic(getAgentDiscussPrefsPath(), clean)
  return clean
}
