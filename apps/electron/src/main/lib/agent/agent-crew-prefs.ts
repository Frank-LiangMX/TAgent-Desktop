/**
 * Agent 班组（agent-crew）用户偏好（主进程落盘）
 *
 * 路径：~/.tagent[-dev]/agent-crew-prefs.json（与其它 tagent 配置同根）。
 * 读写均经 atomic-json（损坏自愈 + 原子写）。
 * 读：缺失 / 损坏 / 结构非法 → 返回默认（不写盘）。
 * 写：整单校验（`validateAgentCrewPrefs`），非法即抛中文错、不脏写盘
 * （与 cli-workers-service 同口径，SPEC 04 §2.2）。
 *
 * 本期：仅落盘 + UI；`maxParallelWorkers` 调度未接、`showFlowAsGraph` 为阶段3预留
 * （见 docs/dev/moa-roundtable/IMPLEMENT-AGENT-DISCUSS-CREW-SETTINGS-FINDINGS.md）。
 */
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { getAgentCrewPrefsPath } from '../config/config-paths'
import {
  AGENT_CREW_PREFS_DEFAULT,
  isValidAgentCrewPrefs,
  sanitizeAgentCrewPrefs,
  validateAgentCrewPrefs,
  type AgentCrewPrefs,
} from '@tagent/shared'

/**
 * 读班组偏好（纯读：缺失/损坏/非法 → 内存默认，不写盘）。
 * 合法则剥离为已知字段后返回（丢弃未知字段）。
 */
export function readAgentCrewPrefs(): AgentCrewPrefs {
  const parsed = readJsonSafe<unknown>(getAgentCrewPrefsPath(), null)
  if (!isValidAgentCrewPrefs(parsed)) {
    return { ...AGENT_CREW_PREFS_DEFAULT }
  }
  return sanitizeAgentCrewPrefs(parsed)
}

/**
 * 写入整份班组偏好（覆盖式原子写）。
 * 整单校验失败（结构非法 / 字段越界 / 类型不符）→ 抛中文错、**不写盘**。
 * 合法则剥离为已知字段后原子写，丢弃未知字段。
 * 设置页保存 IPC（`agent:set-crew-prefs`）经此函数；调用方捕获错误回显给用户。
 */
export function writeAgentCrewPrefs(prefs: unknown): AgentCrewPrefs {
  const err = validateAgentCrewPrefs(prefs)
  if (err) throw new Error(err)
  const clean = sanitizeAgentCrewPrefs(prefs as AgentCrewPrefs)
  writeJsonAtomic(getAgentCrewPrefsPath(), clean)
  return clean
}
