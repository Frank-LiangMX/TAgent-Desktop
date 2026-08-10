/**
 * 子代理相关全局偏好（Jotai + localStorage）
 *
 * 委派积极性默认档：新会话 / 会话 meta 未单独设置时使用。
 * 会话内输入区仍可 per-session 覆盖（写 meta.subagentEagerness）。
 */
import { atomWithStorage } from 'jotai/utils'
import {
  DEFAULT_SUBAGENT_EAGERNESS,
  migrateSubagentEagerness,
  type SubagentEagerness,
} from '@tagent/shared'

/** localStorage key；勿改，改名会丢用户已保存的默认档 */
export const SUBAGENT_EAGERNESS_DEFAULT_STORAGE_KEY = 'tagent:subagentEagernessDefault'

/**
 * 全局默认委派积极性。
 * atomWithStorage 读到非法字符串时仍会写入 atom；读侧请用 migrateSubagentEagerness。
 */
export const subagentEagernessDefaultAtom = atomWithStorage<SubagentEagerness>(
  SUBAGENT_EAGERNESS_DEFAULT_STORAGE_KEY,
  DEFAULT_SUBAGENT_EAGERNESS,
)

/** 规范化 atom 读值（防 localStorage 脏数据） */
export function readSubagentEagernessDefault(
  raw: SubagentEagerness | string | undefined,
): SubagentEagerness {
  return migrateSubagentEagerness(typeof raw === 'string' ? raw : undefined)
}
